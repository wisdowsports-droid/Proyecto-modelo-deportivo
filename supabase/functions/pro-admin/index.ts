import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Panel de administracion del Pro (solo con la llave de dueno).
// body: { key, action, ... }
//   list                                  -> lista de espera + suscriptores
//   grant  { tg_user_id?, name?, days, price } -> crea o renueva al suscriptor y le manda su enlace por Telegram
//   resend { member_id }                  -> vuelve a mandar el enlace por Telegram
//   revoke { member_id }                  -> quita el acceso de inmediato
//   newkey { member_id }                  -> cambia la llave (si el enlace se compartio) y la reenvia

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const bogotaToday = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const randKey = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function tg(method: string, body: unknown) {
  if (!TOKEN) return { ok: false, description: "sin token de Telegram" };
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}

async function sendLink(m: any, pub: string, renewed: boolean) {
  if (!m.tg_user_id) return { sent: false, reason: "sin Telegram" };
  const { data: w } = await supabase.from("pro_waitlist").select("chat_id").eq("tg_user_id", m.tg_user_id).maybeSingle();
  const chat = w?.chat_id ?? String(m.tg_user_id);
  const url = `${pub.replace(/\/$/, "")}/?k=${m.access_key}`;
  const text = (renewed ? "⭐ <b>Tu Kinetik Pro fue renovado</b>" : "⭐ <b>¡Bienvenido a Kinetik Pro!</b>") +
    `\n\nTu acceso está activo hasta el <b>${dmy(m.paid_until)}</b>.\n\nToca el botón para abrir tu panel Pro: la Selección del día, la parrilla completa con partidos en vivo, el radar de valor en BetPlay y la calculadora de combinadas.\n\n<i>Este enlace es personal. Si lo compartes, se puede desactivar.</i>\n\nJuega con cabeza: montos pequeños y siempre iguales. +18`;
  const r = await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "📊 Abrir mi panel Pro", url }]] } });
  return { sent: !!r.ok, reason: r.ok ? null : r.description };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let b: any = {}; try { b = await req.json(); } catch (_e) { /* */ }
  const { data: cfg } = await supabase.from("app_settings").select("key, value").in("key", ["owner_key", "public_url"]);
  const conf = Object.fromEntries((cfg ?? []).map((r: any) => [r.key, r.value]));
  if (!b.key || b.key !== conf.owner_key) return json({ ok: false, error: "Solo el administrador puede usar este panel." }, 403);
  const pub = conf.public_url ?? "https://kinetikpicks.vercel.app/";
  const today = bogotaToday();

  if (b.action === "list") {
    const { data: wl } = await supabase.from("pro_waitlist").select("tg_user_id, first_name, username, joined_at, last_seen, messages, active").order("joined_at", { ascending: false });
    const { data: mem } = await supabase.from("pro_members").select("id, tg_user_id, name, username, price, paid_until, status, created_at, updated_at").order("created_at", { ascending: false });
    const members = (mem ?? []).map((m: any) => ({ ...m, days_left: m.paid_until ? Math.round((Date.parse(m.paid_until) - Date.parse(today)) / 86400e3) : null,
      active: m.status === "active" && m.paid_until && m.paid_until >= today }));
    const mset = new Set(members.map((m: any) => String(m.tg_user_id)));
    return json({ ok: true, today, waitlist: (wl ?? []).filter((w: any) => !mset.has(String(w.tg_user_id))), members });
  }

  if (b.action === "grant") {
    const days = Math.max(1, Math.min(400, parseInt(b.days ?? 30, 10) || 30));
    const price = b.price != null ? parseInt(b.price, 10) || null : null;
    let m: any = null;
    if (b.tg_user_id) { const { data } = await supabase.from("pro_members").select("*").eq("tg_user_id", b.tg_user_id).maybeSingle(); m = data; }
    if (b.member_id && !m) { const { data } = await supabase.from("pro_members").select("*").eq("id", b.member_id).maybeSingle(); m = data; }
    const renewed = !!m;
    if (m) {
      const base = m.status === "active" && m.paid_until && m.paid_until >= today ? m.paid_until : today;
      const { data, error } = await supabase.from("pro_members").update({ paid_until: addDays(base, days), status: "active", price: price ?? m.price, updated_at: new Date().toISOString() }).eq("id", m.id).select("*").single();
      if (error) return json({ ok: false, error: error.message }, 500);
      m = data;
    } else {
      let name = b.name ?? null, username = null;
      if (b.tg_user_id) {
        const { data: w } = await supabase.from("pro_waitlist").select("first_name, username").eq("tg_user_id", b.tg_user_id).maybeSingle();
        name = name ?? w?.first_name ?? null; username = w?.username ?? null;
      }
      if (!b.tg_user_id && !name) return json({ ok: false, error: "Falta el nombre del suscriptor." }, 400);
      const { data, error } = await supabase.from("pro_members").insert({ tg_user_id: b.tg_user_id ?? null, name, username, price, paid_until: addDays(today, days), access_key: randKey() }).select("*").single();
      if (error) return json({ ok: false, error: error.message }, 500);
      m = data;
    }
    const tgr = await sendLink(m, pub, renewed);
    return json({ ok: true, member: { id: m.id, name: m.name, paid_until: m.paid_until }, link: `${pub.replace(/\/$/, "")}/?k=${m.access_key}`, telegram: tgr });
  }

  if (b.action === "resend" || b.action === "newkey") {
    let { data: m } = await supabase.from("pro_members").select("*").eq("id", b.member_id).maybeSingle();
    if (!m) return json({ ok: false, error: "No encontré ese suscriptor." }, 404);
    if (b.action === "newkey") {
      const { data } = await supabase.from("pro_members").update({ access_key: randKey(), updated_at: new Date().toISOString() }).eq("id", m.id).select("*").single();
      m = data;
    }
    const tgr = await sendLink(m, pub, true);
    return json({ ok: true, link: `${pub.replace(/\/$/, "")}/?k=${m.access_key}`, telegram: tgr });
  }

  if (b.action === "revoke") {
    const { error } = await supabase.from("pro_members").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", b.member_id);
    return error ? json({ ok: false, error: error.message }, 500) : json({ ok: true });
  }
  return json({ ok: false, error: "Acción desconocida." }, 400);
});
