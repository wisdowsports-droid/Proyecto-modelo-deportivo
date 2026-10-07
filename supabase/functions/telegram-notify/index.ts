import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { freeCardSvg, resultsCardSvg, svgToPng } from "./card.ts";

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
//   "pin"     -> envia y fija en el chat un mensaje con el boton del dashboard
// El enlace del dashboard se lee de app_settings (key 'dashboard_url').

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

// ---------- Canal publico (app_settings.tg_channel_id) ----------
// ch_welcome: mensaje de bienvenida fijado (una sola vez)
// ch_free:    los picks gratis del dia (una vez al dia)
// ch_results: resultado de los gratis cuando terminan todos (aciertos y fallos)
// ch_weekly:  resumen de los ultimos 7 dias (lunes)
const VOID = new Set(["postponed", "cancelled", "canceled", "abandoned", "void"]);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
const pctTxt = (h: number, n: number) => (n ? Math.round((100 * h) / n) : 0) + "%";
const WELCOME = `<b>Bienvenido a Kinetik Picks</b>

Aquí no vendemos humo ni partidos "arreglados". Usamos un modelo estadístico que calcula la probabilidad real de cada resultado, la comparamos con lo que pagan las casas y publicamos todo: <b>los aciertos y también los fallos.</b>

<b>Qué vas a recibir gratis, todos los días</b>
• <b>6:05 a. m.:</b> los 3 picks de mayor probabilidad del día, cada uno con su porcentaje.
• <b>En la noche:</b> el resultado de cada pick, marcado con ✓ o ✗, sin borrar nada.
• <b>Los lunes:</b> el resumen de la semana, con números reales.

<b>Cómo leer un pick</b>
"Nacional o empate · 87 %" quiere decir que, de cada 100 partidos así, el modelo espera acertar unos 87. Alto no es seguro: 1 de cada 7 u 8 va a fallar, y eso lo vas a ver aquí.

<b>Nuestro historial</b>
Cada pick queda registrado antes del partido y no se borra. En cada resultado publicamos el acumulado en vivo, y en la página puedes revisar todo el historial.

<b>¿Quieres más?</b>
La versión Pro trae la Selección completa del día, la parrilla completa de todos los deportes y la calculadora de combinadas. Toca "Quiero el Pro" para entrar a la lista de espera.

<b>Juega con cabeza</b>
Solo mayores de 18 años. Apuesta montos pequeños y siempre iguales, no persigas pérdidas y nunca apuestes dinero que necesites. Ningún pronóstico garantiza ganancias.`;

// ---------- imagenes para canal y redes ----------
async function tgPhoto(chat: string, png: Uint8Array, caption: string, kb?: unknown) {
  const fd = new FormData();
  fd.append("chat_id", chat);
  fd.append("photo", new Blob([png], { type: "image/png" }), "kinetik.png");
  fd.append("caption", caption.length > 1000 ? caption.slice(0, 990) + "…" : caption);
  fd.append("parse_mode", "HTML");
  if (kb) fd.append("reply_markup", JSON.stringify(kb));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
  return await r.json();
}
const dayLabel = (date: string) => {
  const w = new Date(date + "T12:00:00Z").toLocaleDateString("es-CO", { weekday: "long", timeZone: "UTC" });
  return w.charAt(0).toUpperCase() + w.slice(1) + " " + ddmm(date);
};
const shortLeague = (l: string) => String(l ?? "").replace(/\s*\(.*\)\s*/, "").trim();
const pickLabel = (p: any) => String(p.label ?? ((p.dc_pick === "1X" ? p.home_team : p.away_team) + " o empate")).replace(/\s*\(tenis\)$/, "");
async function freeCard(date: string, rows: any[]) {
  return await svgToPng(freeCardSvg(dayLabel(date), rows.map((p: any) => ({
    home: p.home_team, away: p.away_team, time: hhmm(p.commence_time), league: shortLeague(p.league), label: pickLabel(p), prob: +p.dc_prob,
  }))));
}
async function resultsCard(date: string, rows: any[], h: number, n: number, H: number, N: number) {
  return await svgToPng(resultsCardSvg(dayLabel(date), rows.map((p: any) => ({
    home: p.home_team, away: p.away_team, label: pickLabel(p), score: p.home_score != null ? `${p.home_score}-${p.away_score}` : null, hit: p.hit,
  })), h, n, H, N));
}
// copia de la imagen al chat privado del dueno, lista para compartir en estados / reels
async function ownerCopy(png: Uint8Array, caption: string) {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "telegram_chat_id").maybeSingle();
  if (data?.value) await tgPhoto(data.value, png, caption);
}

async function channel(mode: string) {
  const { data: cfgRows } = await supabase.from("app_settings").select("key, value").in("key", ["tg_channel_id", "public_url"]);
  const cfg: Record<string, string> = Object.fromEntries((cfgRows ?? []).map((r: any) => [r.key, r.value]));
  const ch = cfg.tg_channel_id;
  if (!ch) return json({ ok: false, error: "Falta tg_channel_id en app_settings" }, 400);
  const pub = cfg.public_url ?? "https://kinetikpicks.vercel.app/";
  const kb = { inline_keyboard: [[{ text: "📊 Ver en la página", url: pub }], [{ text: "⭐ Quiero el Pro", url: "https://t.me/Kinetikpicks_alertas_bot?start=pro" }]] };
  const post = (text: string) => tg("sendMessage", { chat_id: ch, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });

  if (mode === "ch_welcome") {
    if (await alreadySent("ch_welcome", "2000-01-01")) return json({ ok: true, skipped: "ya publicado" });
    const r = await post(WELCOME);
    if (r.ok) {
      await markSent("ch_welcome", "2000-01-01");
      const p = await tg("pinChatMessage", { chat_id: ch, message_id: r.result.message_id, disable_notification: true });
      return json({ ok: true, publicado: true, fijado: p.ok ? true : p.description });
    }
    return json({ ok: false, telegram: r.description });
  }

  if (mode === "ch_welcome_edit") {
    const info = await tg("getChat", { chat_id: ch });
    const mid = info?.result?.pinned_message?.message_id;
    if (!mid) return json({ ok: false, error: "no hay mensaje fijado" }, 400);
    const r = await tg("editMessageText", { chat_id: ch, message_id: mid, text: WELCOME, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
    return json({ ok: r.ok, telegram: r.ok ? "actualizado" : r.description });
  }

  if (mode === "ch_free") {
    const date = bogotaDate();
    if (await alreadySent("ch_free", date)) return json({ ok: true, skipped: "ya publicado" });
    const { data: rows } = await supabase.from("free_picks").select("*").eq("pick_date", date).order("commence_time");
    if (!rows?.length) return json({ ok: true, skipped: "sin picks gratis hoy" });
    const lines = rows.map((p: any, i: number) => {
      const label = p.label ?? ((p.dc_pick === "1X" ? p.home_team : p.away_team) + " o empate");
      return `<b>${i + 1}.</b> ${esc(p.home_team)} vs ${esc(p.away_team)} · ${hhmm(p.commence_time)}\n    <b>${esc(label)}</b> · ${Math.round(+p.dc_prob * 100)}%`;
    });
    const text = `🎯 <b>Gratis de hoy · ${ddmm(date)}</b>\n\n${lines.join("\n\n")}\n\n<i>Probabilidad según nuestro modelo. Alto no es seguro: esta noche publicamos el resultado, acierte o falle.</i>`;
    let r: any, img = "no";
    try {
      const png = await freeCard(date, rows);
      r = await tgPhoto(ch, png, text, kb); img = "si";
      if (r.ok) await ownerCopy(png, "📲 Imagen de hoy para compartir en estados y redes");
    } catch (e) { r = await post(text); img = "error: " + String(e).slice(0, 120); }
    if (r.ok) await markSent("ch_free", date);
    return json({ ok: r.ok, picks: rows.length, imagen: img, telegram: r.ok ? "publicado" : r.description });
  }

  if (mode === "ch_results") {
    const out: any[] = [];
    for (const date of [bogotaDate(-1), bogotaDate()]) {
      if (await alreadySent("ch_results", date)) { out.push({ date, skipped: "ya publicado" }); continue; }
      if (!(await alreadySent("ch_free", date))) { out.push({ date, skipped: "no se publicaron gratis ese dia" }); continue; }
      const { data: rows } = await supabase.from("free_picks_results").select("*").eq("pick_date", date).order("commence_time");
      if (!rows?.length) { out.push({ date, skipped: "sin picks" }); continue; }
      const pending = rows.filter((r: any) => r.hit == null && !VOID.has(String(r.status))).length;
      if (pending) { out.push({ date, skipped: `${pending} pendientes` }); continue; }
      const graded = rows.filter((r: any) => r.hit != null);
      const h = graded.filter((r: any) => r.hit).length;
      const lines = rows.map((p: any) => {
        const label = p.label ?? ((p.dc_pick === "1X" ? p.home_team : p.away_team) + " o empate");
        const icon = p.hit == null ? "➖" : p.hit ? "✅" : "❌";
        const sc = p.home_score != null ? ` · <b>${p.home_score}-${p.away_score}</b>` : " · anulado";
        return `${icon} ${esc(p.home_team)} vs ${esc(p.away_team)} · ${esc(label)}${sc}`;
      });
      const { data: all } = await supabase.from("free_picks_results").select("hit").not("hit", "is", null);
      const N = all?.length ?? 0, H = (all ?? []).filter((r: any) => r.hit).length;
      const text = `📊 <b>Gratis del ${ddmm(date)}: ${h} de ${graded.length}</b>\n\n${lines.join("\n")}\n\nEn vivo desde el inicio: <b>${H} de ${N} (${pctTxt(H, N)})</b>`;
      let r: any, img = "no";
      try {
        const png = await resultsCard(date, rows, h, graded.length, H, N);
        r = await tgPhoto(ch, png, text, kb); img = "si";
        if (r.ok) await ownerCopy(png, "📲 Resultados para compartir en estados y redes");
      } catch (e) { r = await post(text); img = "error: " + String(e).slice(0, 120); }
      if (r.ok) await markSent("ch_results", date);
      out.push({ date, imagen: img, telegram: r.ok ? "publicado" : r.description });
    }
    return json({ ok: true, out });
  }

  if (mode === "ch_weekly") {
    const date = bogotaDate();
    if (await alreadySent("ch_weekly", date)) return json({ ok: true, skipped: "ya publicado" });
    const from = bogotaDate(-7), to = bogotaDate(-1);
    const { data: fr } = await supabase.from("free_picks_results").select("hit").gte("pick_date", from).lte("pick_date", to).not("hit", "is", null);
    const { data: sr } = await supabase.from("selection_results").select("hit").gte("pick_date", from).lte("pick_date", to).not("hit", "is", null);
    const fn = fr?.length ?? 0, fh = (fr ?? []).filter((r: any) => r.hit).length;
    const sn = sr?.length ?? 0, sh = (sr ?? []).filter((r: any) => r.hit).length;
    if (!fn && !sn) return json({ ok: true, skipped: "sin datos de la semana" });
    const text = `🗓 <b>Así nos fue · ${ddmm(from)} al ${ddmm(to)}</b>\n\n` +
      (fn ? `Picks gratis: <b>${fh} de ${fn} (${pctTxt(fh, fn)})</b>\n` : "") +
      (sn ? `Selección Pro: <b>${sh} de ${sn} (${pctTxt(sh, sn)})</b>\n` : "") +
      `\n<i>Todo publicado: aciertos y fallos. Nada se borra.</i>`;
    const r = await post(text);
    if (r.ok) await markSent("ch_weekly", date);
    return json({ ok: r.ok, telegram: r.ok ? "publicado" : r.description });
  }
  if (mode === "ch_preview") {
    // prueba: arma ambas tarjetas con los ultimos datos y las manda SOLO al chat privado del dueno
    const { data: lastF } = await supabase.from("free_picks").select("pick_date").order("pick_date", { ascending: false }).limit(1);
    const out: any = {};
    if (lastF?.length) {
      const d = lastF[0].pick_date;
      const { data: rows } = await supabase.from("free_picks").select("*").eq("pick_date", d).order("commence_time");
      try { await ownerCopy(await freeCard(d, rows ?? []), "Vista previa · Gratis de hoy"); out.free = "enviada"; } catch (e) { out.free = String(e).slice(0, 200); }
      const { data: res } = await supabase.from("free_picks_results").select("*").eq("pick_date", d).order("commence_time");
      const { data: all } = await supabase.from("free_picks_results").select("hit").not("hit", "is", null);
      const g = (res ?? []).filter((r: any) => r.hit != null);
      try {
        await ownerCopy(await resultsCard(d, res ?? [], g.filter((r: any) => r.hit).length, g.length, (all ?? []).filter((r: any) => r.hit).length, all?.length ?? 0), "Vista previa · Así nos fue");
        out.results = "enviada";
      } catch (e) { out.results = String(e).slice(0, 200); }
    }
    return json({ ok: true, out });
  }
  return json({ ok: false, error: "modo de canal desconocido" }, 400);
}

Deno.serve(async (req: Request) => {
  if (!TOKEN) return json({ ok: false, error: "Falta el secreto TELEGRAM_BOT_TOKEN en Supabase (Edge Functions -> Secrets)." }, 400);
  let mode = "results";
  try { const b = await req.json(); if (b?.mode) mode = b.mode; } catch (_e) { /* default */ }

  if (mode.startsWith("ch_")) return await channel(mode);

  const chat = await chatId();
  if (!chat) return json({ ok: false, error: lastUpdatesError ?? "No encontre tu chat. Abre tu bot en Telegram y escribele /start, luego intenta de nuevo." }, 400);
  const { data: du } = await supabase.from("app_settings").select("value").eq("key", "dashboard_url").maybeSingle();
  const dashUrl = du?.value ?? null;
  // boton "Abrir dashboard" debajo de cada mensaje
  const send = (text: string) => tg("sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(dashUrl ? { reply_markup: { inline_keyboard: [[{ text: "📊 Abrir dashboard", url: dashUrl }]] } } : {}),
  });

  if (mode === "pin") {
    if (!dashUrl) return json({ ok: false, error: "Falta dashboard_url en app_settings" }, 400);
    const r = await send("📊 <b>Tu dashboard de Kinetik Picks</b>\nToca el botón para ver los picks gratis de hoy, su historial y el récord en vivo. Se actualiza solo.");
    if (r.ok) await tg("pinChatMessage", { chat_id: chat, message_id: r.result.message_id, disable_notification: true });
    return json({ ok: r.ok, telegram: r.ok ? "enviado y fijado" : r.description });
  }

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
