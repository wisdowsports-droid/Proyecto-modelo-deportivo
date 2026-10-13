import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Combinada del dia (privada, solo al dueno por Telegram).
// 2 patas de partidos distintos, cuota total 1,50-1,80 en BetPlay, cada pata >= 70 % segun Pinnacle sin margen,
// el modelo no la contradice, y la combinada paga igual o mas de lo justo. Si no hay, lo dice.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const bogotaToday = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const pct = (x: number) => `${Math.round(x * 100)} %`;
const dec = (x: number) => Number(x).toFixed(2).replace(".", ",");
const hora = (t: string) => new Date(t).toLocaleString("es-CO", { timeZone: "America/Bogota", weekday: "short", hour: "numeric", minute: "2-digit" });
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch (_e) { /* */ }
  const { data: ok } = await supabase.from("app_settings").select("value").eq("key", "owner_key").single();
  if (!body.key || body.key !== ok?.value) return new Response(JSON.stringify({ ok: false }), { status: 403 });
  const date = body.date ?? bogotaToday();
  const { error: be } = await supabase.rpc("build_daily_combo", { p_date: date });
  if (be) return new Response(JSON.stringify({ ok: false, error: be.message }), { status: 500 });

  const { data: c } = await supabase.from("daily_combos").select("*").eq("combo_date", date).single();
  const { data: legs } = await supabase.from("daily_combo_legs").select("*").eq("combo_id", c.id).order("kickoff");
  const { data: hist } = await supabase.from("daily_combo_results").select("result, total_odds").in("result", ["won", "lost"]);
  const won = (hist ?? []).filter((h: any) => h.result === "won");
  const n = (hist ?? []).length;
  const units = won.reduce((a: number, h: any) => a + (Number(h.total_odds) - 1), 0) - (n - won.length);

  let text = `🎯 <b>Combinada del día</b> · ${date.slice(8, 10)}/${date.slice(5, 7)}\n\n`;
  if (c.status === "none" || !legs?.length) {
    text += "Hoy <b>no hay</b> combinada de 2 patas que BetPlay pague bien. Mejor no apostar o ir con un sencillo de la Selección.";
  } else {
    legs.forEach((l: any, i: number) => {
      text += `${i + 1}. ${esc(l.description)}\n   Cuota BetPlay <b>${dec(l.bp_price)}</b> · prob. ${pct(l.fair_prob)}${l.model_prob ? ` (modelo ${pct(l.model_prob)})` : ""} · ${hora(l.kickoff)}\n`;
    });
    text += `\n<b>Cuota total ${dec(c.total_odds)}</b> · prob. ${pct(c.prob)} · cuota justa ${dec(1 / c.prob)}`;
    if (c.note) text += `\n<i>${esc(c.note)}</i>`;
    text += `\n\nAntes de apostar revisa que BetPlay siga pagando ${dec(c.total_odds)} o más. Si bajó de ${dec(1 / c.prob)}, no la hagas.`;
  }
  if (n) text += `\n\n📈 Récord: ${won.length}/${n} ganadas · ${units >= 0 ? "+" : ""}${units.toFixed(2).replace(".", ",")} u`;
  text += "\n\nMonto pequeño y siempre igual. +18";

  if (body.dry) return new Response(JSON.stringify({ ok: true, text }), { headers: { "Content-Type": "application/json" } });
  const { data: s } = await supabase.from("app_settings").select("value").eq("key", "telegram_chat_id").single();
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: s?.value, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json();
  return new Response(JSON.stringify({ ok: !!j.ok, sent: !!j.ok, error: j.ok ? null : j.description }), { headers: { "Content-Type": "application/json" } });
});
