import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Buscador de cuotas: trae la cuota 1X2 de TODAS las casas de la region "eu"
// de The Odds API (incluye Pinnacle) para las ligas con partidos proximos,
// guarda cada cuota en odds_prices y el precio justo de Pinnacle sin margen
// (Shin) en fixtures.fair_*. La vista value_opportunities compara.
//
// Costo: 1 credito por liga (markets=h2h, regions=eu). Solo actualiza
// partidos que ya existen en fixtures (los crea sync-fixtures).
//
// body opcional: { sport_keys: ["soccer_epl", ...], hours: 96, sport: "soccer" }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function shin(odds: number[]): number[] {
  const p = odds.map((o) => 1 / o), total = p.reduce((a, b) => a + b, 0);
  if (total <= 1) return p.map((v) => v / total);
  const piOf = (z: number) => p.map((pi) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / total) - z) / (2 * (1 - z)));
  const f = (z: number) => piOf(z).reduce((a, b) => a + b, 0) - 1;
  let lo = 0, hi = 1 - 1e-9;
  if (f(lo) * f(hi) > 0) return p.map((v) => v / total);
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
  const r = piOf((lo + hi) / 2), s = r.reduce((a, b) => a + b, 0);
  return r.map((v) => v / s);
}

Deno.serve(async (req: Request) => {
  if (!ODDS_API_KEY) return new Response(JSON.stringify({ ok: false, error: "ODDS_API_KEY no configurada" }), { status: 400 });
  let cfg: any = {};
  try { cfg = await req.json(); } catch (_e) { /* defaults */ }
  const hours = cfg.hours ?? 96;

  let keys: string[] = cfg.sport_keys ?? [];
  if (!keys.length) {
    let q = supabase.from("fixtures").select("odds_api_sport_key")
      .eq("status", "scheduled").not("odds_api_sport_key", "is", null)
      .gt("commence_time", new Date().toISOString())
      .lt("commence_time", new Date(Date.now() + hours * 3600 * 1000).toISOString());
    if (cfg.sport) q = q.eq("sport", cfg.sport);
    const { data, error } = await q;
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    keys = [...new Set((data ?? []).map((r: any) => r.odds_api_sport_key as string))];
  }

  const summary: any = { ok: true, keys, events: 0, matchedFixtures: 0, pricesSaved: 0, withPinnacle: 0, creditsRemaining: null, errors: [] as string[] };
  for (const key of keys) {
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
      summary.creditsRemaining = res.headers.get("x-requests-remaining") ?? summary.creditsRemaining;
      if (!res.ok) { summary.errors.push(`${key}: ${res.status}`); continue; }
      const events: any[] = await res.json();
      summary.events += events.length;
      if (!events.length) continue;

      const extIds = events.map((e) => `oddsapi_${e.id}`);
      const { data: fxs } = await supabase.from("fixtures").select("id, external_id").in("external_id", extIds);
      const idByExt = new Map((fxs ?? []).map((f: any) => [f.external_id, f.id]));

      const rows: any[] = [];
      for (const ev of events) {
        const fixtureId = idByExt.get(`oddsapi_${ev.id}`);
        if (!fixtureId) continue;
        summary.matchedFixtures++;
        for (const bm of ev.bookmakers ?? []) {
          const m = (bm.markets ?? []).find((x: any) => x.key === "h2h");
          if (!m) continue;
          let h: number | null = null, d: number | null = null, a: number | null = null;
          for (const o of m.outcomes ?? []) {
            if (o.name === ev.home_team) h = o.price; else if (o.name === ev.away_team) a = o.price; else if (o.name === "Draw") d = o.price;
          }
          rows.push({ fixture_id: fixtureId, bookmaker_key: bm.key, bookmaker: bm.title, price_home: h, price_draw: d, price_away: a, last_update: m.last_update ?? bm.last_update, fetched_at: new Date().toISOString() });
          if (bm.key === "pinnacle" && h && a) {
            const hasDraw = d != null;
            const fair = shin(hasDraw ? [h, d!, a] : [h, a]);
            const upd = hasDraw
              ? { fair_home: fair[0], fair_draw: fair[1], fair_away: fair[2] }
              : { fair_home: fair[0], fair_draw: null, fair_away: fair[1] };
            await supabase.from("fixtures").update({ ...upd, fair_source: "pinnacle", fair_updated_at: new Date().toISOString(), pinnacle_last_update: m.last_update ?? bm.last_update }).eq("id", fixtureId);
            summary.withPinnacle++;
          }
        }
      }
      if (rows.length) {
        const { error } = await supabase.from("odds_prices").upsert(rows, { onConflict: "fixture_id,bookmaker_key" });
        if (error) summary.errors.push(`${key} upsert: ${error.message}`); else summary.pricesSaved += rows.length;
      }
    } catch (e) {
      summary.errors.push(`${key}: ${String(e).slice(0, 120)}`);
    }
  }
  return new Response(JSON.stringify(summary, null, 1), { headers: { "Content-Type": "application/json" } });
});
