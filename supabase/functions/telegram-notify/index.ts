import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Alertas por Telegram de la "Seleccion del dia".
// Secreto requerido (Supabase -> Edge Functions -> Secrets): TELEGRAM_BOT_TOKEN
// El chat se detecta solo: el usuario le escribe /start al bot y se guarda su
// chat_id en app_settings.
//
// body { mode }:
//   "detect"  -> busca el chat del usuario y manda un mensaje de prueba
//   "morning" -> manda los picks de hoy (una vez por dia)
//   "results" -> si ya terminaron todos los picks de hoy/ayer, manda el resumen (una vez por dia)
//   "test"    -> mensaje de prueba

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "Content-Type": "application/json" } });

async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json();
}

let lastUpdatesError: string | null = null;
async function chatId(): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "telegram_chat_id").maybeSingle();
  if (data?.value) return data.value;
  const up = await tg("getUpdates", { limit: 50 });
  if (!up.ok) { lastUpdatesError = `Telegram rechazo el token: ${up.description ?? "desconocido"}`; return null; }
  const msgs = (up.result ?? []).map((u: any) => u.message ?? u.my_chat_member).filter((m: any) => m?.chat?.type === "private");
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const id = String(last.chat.id);
  await supabase.from("app_settings").upsert({ key: "telegram_chat_id", value: id, updated_at: new Date().toISOString() });
  return id;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bogotaDate = (offsetDays = 0) => {
  const d = new Date(Date.now() - 5 * 3600000 + offsetDays * 86400000); // Bogota UTC-5, sin horario de verano
  return d.toISOString().slice(0, 10);
};
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

async function alreadySent(kind: string, date: string) {
  const { data } = await supabase.from("telegram_sent").select("kind").eq("kind", kind).eq("ref_date", date).maybeSingle();
  return !!data;
}
async function markSent(kind: string, date: string) {
  await supabase.from("telegram_sent").upsert({ kind, ref_date: date });
}

Deno.serve(async (req: Request) => {
  if (!TOKEN) return json({ ok: false, error: "Falta el secreto TELEGRAM_BOT_TOKEN en Supabase (Edge Functions -> Secrets)." }, 400);
  let mode = "results";
  try { const b = await req.json(); if (b?.mode) mode = b.mode; } catch (_e) { /* default */ }

  const chat = await chatId();
  if (!chat) return json({ ok: false, error: lastUpdatesError ?? "No encontre tu chat. Abre tu bot en Telegram y escribele /start, luego intenta de nuevo." }, 400);
  const send = (text: string) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });

  if (mode === "detect" || mode === "test") {
    const r = await send("✅ <b>Kinetik Picks conectado</b>\nDesde ahora te aviso aquí los picks de la Selección del día y sus resultados apenas termine el último partido.");
    return json({ ok: r.ok, chat, telegram: r.ok ? "enviado" : r.description });
  }

  if (mode === "morning") {
    const date = bogotaDate();
    if (await alreadySent("morning", date)) return json({ ok: true, skipped: "ya enviado" });
    const { data: st } = await supabase.rpc("selection_alert_status", { p_date: date });
    if (!st?.hay_seleccion) return json({ ok: true, skipped: "sin seleccion hoy" });
    const lines = (st.picks as any[]).filter((p) => p.resultado !== "anulado").map((p) =>
      `<b>${p.rank}.</b> ${esc(p.partido)}\n    ${esc(p.pick)} · <b>${p.prob}%</b> · cuota mínima <b>${String(p.cuota_minima).replace(".", ",")}</b>`);
    const text = `🎯 <b>Selección del ${ddmm(date)}</b>\n\n${lines.join("\n\n")}\n\n<i>Apuesta solo si la casa paga más que la cuota mínima. Mejor por separado que en combinada.</i>`;
    const r = await send(text);
    if (r.ok) await markSent("morning", date);
    return json({ ok: r.ok, sent: lines.length, telegram: r.ok ? "enviado" : r.description });
  }

  // results: revisa ayer y hoy
  const out: any[] = [];
  for (const date of [bogotaDate(-1), bogotaDate()]) {
    if (await alreadySent("results", date)) { out.push({ date, skipped: "ya enviado" }); continue; }
    const { data: st } = await supabase.rpc("selection_alert_status", { p_date: date });
    if (!st?.hay_seleccion) { out.push({ date, skipped: "sin seleccion" }); continue; }
    if (+st.pendientes > 0) { out.push({ date, skipped: `${st.pendientes} pendientes` }); continue; }
    const icon: Record<string, string> = { acertado: "✅", fallado: "❌", anulado: "➖", aplazado: "➖" };
    const lines = (st.picks as any[]).map((p) =>
      `${icon[p.resultado] ?? "•"} ${esc(p.partido)} · ${esc(p.pick)} (${p.prob}%)${p.marcador && p.resultado !== "anulado" ? ` · <b>${esc(p.marcador)}</b>` : p.resultado === "anulado" ? " · anulado" : ""}`);
    const pctRec = +st.record_total ? Math.round((100 * +st.record_aciertos) / +st.record_total) : 0;
    const text = `📊 <b>Selección del ${ddmm(date)}: ${st.dia_aciertos} de ${st.dia_calificados} acertados</b>\n\n${lines.join("\n")}\n\nRécord en vivo de la Selección: <b>${st.record_aciertos} de ${st.record_total} (${pctRec}%)</b>`;
    const r = await send(text);
    if (r.ok) await markSent("results", date);
    out.push({ date, telegram: r.ok ? "enviado" : r.description });
  }
  return json({ ok: true, out });
});
