import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Webhook del bot de Telegram: lista de espera de Kinetik Pro.
// Telegram llama aqui cada vez que alguien le escribe al bot.
//  - Cualquier persona que escribe queda en pro_waitlist y recibe una bienvenida
//    con el boton de la pagina publica (solo lo gratis).
//  - /salir la saca de la lista.
//  - Al dueno (app_settings.telegram_chat_id) le llega un aviso por cada nuevo
//    interesado, y puede escribir /lista para ver el total.
// Seguridad: se despliega sin verificacion JWT (Telegram no manda JWT), y en su lugar
// exige el encabezado X-Telegram-Bot-Api-Secret-Token = app_settings.tg_webhook_secret.
// Configuracion inicial: POST {"setup": "<tg_webhook_secret>"} registra el webhook.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const ok = (o: unknown = { ok: true }) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json();
}
async function setting(key: string): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" || !TOKEN) return ok({ ok: false });
  const secret = await setting("tg_webhook_secret");
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* vacio */ }

  // registro del webhook (solo con el secreto)
  if (body?.setup) {
    if (!secret || body.setup !== secret) return new Response("forbidden", { status: 403 });
    const hook = await tg("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-webhook`, secret_token: secret,
      allowed_updates: ["message"], drop_pending_updates: false,
    });
    const cmds = await tg("setMyCommands", { commands: [
      { command: "start", description: "Unirme a la lista de espera de Kinetik Pro" },
      { command: "gratis", description: "Ver los pronósticos gratis de hoy" },
      { command: "salir", description: "Dejar de recibir avisos" },
    ] });
    return ok({ ok: true, webhook: hook.ok ? "registrado" : hook.description, commands: cmds.ok });
  }

  if (!secret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });

  const m = body?.message;
  if (!m?.chat || m.chat.type !== "private" || !m.from || m.from.is_bot) return ok();
  const chat = String(m.chat.id);
  const text = String(m.text ?? "").trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const owner = await setting("telegram_chat_id");
  const publicUrl = (await setting("public_url")) ?? "https://kinetikpicks.vercel.app/";
  const btn = { reply_markup: { inline_keyboard: [[{ text: "⚽ Ver los gratis de hoy", url: publicUrl }]] } };
  const reply = (t: string, extra: object = btn) => tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

  // el dueno: comandos de control, no entra a la lista
  if (chat === owner) {
    if (cmd === "/lista") {
      const { count } = await supabase.from("pro_waitlist").select("*", { count: "exact", head: true }).eq("active", true);
      const { data: last } = await supabase.from("pro_waitlist").select("first_name, username, joined_at").eq("active", true).order("joined_at", { ascending: false }).limit(5);
      const lines = (last ?? []).map((u: any) => `• ${esc(u.first_name ?? "")}${u.username ? " (@" + esc(u.username) + ")" : ""} · ${String(u.joined_at).slice(0, 10)}`);
      await reply(`📋 <b>Lista de espera Pro: ${count ?? 0} personas</b>${lines.length ? "\n\nÚltimos:\n" + lines.join("\n") : ""}`, {});
    } else {
      await reply("Hola. Este es tu bot. Comandos: /lista para ver cuántos están en la lista de espera Pro. Tu dashboard está en el mensaje fijado.", {});
    }
    return ok();
  }

  // cualquier otra persona
  const { data: prev } = await supabase.from("pro_waitlist").select("active, messages").eq("tg_user_id", m.from.id).maybeSingle();
  if (cmd === "/salir" || cmd === "/stop") {
    if (prev) await supabase.from("pro_waitlist").update({ active: false, last_seen: new Date().toISOString() }).eq("tg_user_id", m.from.id);
    await reply("Listo, saliste de la lista. No te enviaremos más avisos. Si cambias de idea, escribe /start.");
    return ok();
  }

  const row = {
    tg_user_id: m.from.id, chat_id: chat, first_name: m.from.first_name ?? null, username: m.from.username ?? null,
    language: m.from.language_code ?? null, last_seen: new Date().toISOString(), active: true, messages: (prev?.messages ?? 0) + 1,
  };
  await supabase.from("pro_waitlist").upsert(row);
  const isNew = !prev || prev.active === false;

  if (cmd === "/gratis") {
    await reply("⚽ Los pronósticos gratis de hoy (doble oportunidad con 85 % o más) están en la página. Se publican cada mañana a las 6:00 a. m. (hora de Colombia).");
  } else if (isNew || cmd === "/start") {
    await reply(
      `👋 ¡Hola${m.from.first_name ? " " + esc(m.from.first_name) : ""}! Quedaste en la <b>lista de espera de Kinetik Pro</b>.\n\n` +
      `Pro incluye la <b>Selección del día</b> (hasta 5 partidos con la probabilidad más alta y su cuota mínima), la parrilla completa y alertas aquí mismo. Te escribimos por este chat cuando abra.\n\n` +
      `Mientras tanto, los pronósticos gratis de cada día están en la página 👇\n\n<i>Son pronósticos, no garantía. Solo para mayores de 18. Escribe /salir si no quieres avisos.</i>`);
  } else {
    await reply("Ya estás en la lista de espera de Kinetik Pro ✅. Te avisamos aquí cuando abra. Los gratis de hoy están en la página.");
  }

  if (isNew && owner) {
    const { count } = await supabase.from("pro_waitlist").select("*", { count: "exact", head: true }).eq("active", true);
    await tg("sendMessage", { chat_id: owner, parse_mode: "HTML",
      text: `🆕 Nuevo interesado en Pro: <b>${esc(m.from.first_name ?? "")}</b>${m.from.username ? " (@" + esc(m.from.username) + ")" : ""}\nLista de espera: <b>${count ?? 1}</b>` });
  }
  return ok();
});
