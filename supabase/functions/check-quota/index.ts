import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Saldo real de creditos de The Odds API. Consulta /sports, que no gasta
// creditos pero devuelve los encabezados x-requests-remaining y
// x-requests-used, y lo guarda en api_quota (lo lee el dashboard y la
// actualizacion automatica de cuotas para frenarse si el saldo baja).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (_req: Request) => {
  if (!ODDS_API_KEY) return new Response(JSON.stringify({ ok: false, error: "ODDS_API_KEY no configurada" }), { status: 400 });
  const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  await res.body?.cancel();
  if (remaining == null) return new Response(JSON.stringify({ ok: false, status: res.status, error: "la API no devolvio el saldo" }), { status: 502 });
  const { error } = await supabase.from("api_quota").upsert({ api: "the-odds-api", remaining: parseInt(remaining, 10), updated_at: new Date().toISOString() });
  return new Response(JSON.stringify({ ok: !error, remaining: +remaining, used: used == null ? null : +used, error: error?.message ?? null }), {
    headers: { "Content-Type": "application/json" },
  });
});
