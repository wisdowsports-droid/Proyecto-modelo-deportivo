import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Marcadores en vivo (ESPN, gratis) para los partidos de la parrilla que ya empezaron.
// body: { ids: number[] }  ->  { scores: { [fixture_id]: { h, a, state, detail } } }
// state: "in" (jugandose), "post" (terminado), "pre" (no ha empezado). Tenis no tiene marcador en vivo aqui.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

const SOCCER: Record<string, string> = {
  "EPL": "eng.1", "Championship - England": "eng.2", "League One - England": "eng.3", "La Liga - Spain": "esp.1", "La Liga 2 - Spain": "esp.2",
  "Serie A - Italy": "ita.1", "Serie B - Italy": "ita.2", "Bundesliga - Germany": "ger.1", "2. Bundesliga - Germany": "ger.2",
  "Ligue 1 - France": "fra.1", "Ligue 2 - France": "fra.2", "Eredivisie - Netherlands": "ned.1", "Pro League - Belgium": "bel.1",
  "Primeira Liga - Portugal": "por.1", "Super Lig - Turkey": "tur.1", "Super League - Greece": "gre.1", "Premiership - Scotland": "sco.1",
  "Bundesliga - Austria": "aut.1", "Superliga - Denmark": "den.1", "Eliteserien - Norway": "nor.1", "Allsvenskan - Sweden": "swe.1",
  "J1 League - Japan": "jpn.1", "Primera División - Argentina": "arg.1", "Brazil Série A": "bra.1", "Liga MX": "mex.1", "MLS": "usa.1",
  "Liga BetPlay (Colombia Primera A)": "col.1", "Primera División - Uruguay": "uru.1", "Liga 1 - Peru": "per.1",
  "Primera División - Chile": "chi.1", "LigaPro - Ecuador": "ecu.1", "Primera División - Paraguay": "par.1",
  "UEFA Champions League": "uefa.champions", "UEFA Europa League": "uefa.europa", "Copa Libertadores": "conmebol.libertadores",
  "Copa Sudamericana": "conmebol.sudamericana", "UEFA Nations League": "uefa.nations",
};
const OTHER: Record<string, string> = { NFL: "football/nfl", NBA: "basketball/nba", WNBA: "basketball/wnba", MLB: "baseball/mlb", NHL: "hockey/nhl" };

const STOP = new Set(["fc", "cf", "sc", "ac", "as", "cd", "ud", "rc", "sd", "club", "de", "del", "la", "el", "the", "afc", "cfc", "sk", "fk", "if", "bk"]);
function norm(s: string) {
  return s.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss").replace(/ł/g, "l")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.\-()'/&]/g, " ").replace(/\s+/g, " ").trim();
}
const tokens = (s: string) => norm(s).split(" ").filter((t) => t && !STOP.has(t));
function sameTeam(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  for (const x of A) for (const y of B) {
    if (x === y && x.length >= 3) return true;
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
    let k = 0; while (k < x.length && k < y.length && x[k] === y[k]) k++;
    if (k >= 5) return true;
  }
  return false;
}
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch (_e) { /* */ }
  const ids: number[] = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 80);
  if (!ids.length) return new Response(JSON.stringify({ scores: {} }), { headers: { ...CORS, "Content-Type": "application/json" } });
  const { data: fx } = await supabase.from("fixtures").select("id, sport, league, home_team, away_team, commence_time").in("id", ids);
  const paths = new Map<string, any[]>();
  const pathOf = (f: any) => f.sport === "soccer" ? (SOCCER[f.league] ? `soccer/${SOCCER[f.league]}` : null) : (OTHER[f.league] ?? null);
  for (const f of fx ?? []) {
    const p = pathOf(f); if (!p) continue;
    const t = Date.parse(f.commence_time);
    for (const d of [ymd(t - 6 * 3600e3), ymd(t)]) paths.set(`${p}|${d}`, []);
  }
  await Promise.all([...paths.keys()].map(async (k) => {
    const [p, d] = k.split("|");
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${p}/scoreboard?dates=${d}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) paths.set(k, (await r.json()).events ?? []);
    } catch (_e) { /* sin datos */ }
  }));
  const scores: Record<string, any> = {};
  for (const f of fx ?? []) {
    const p = pathOf(f); if (!p) continue;
    const t = Date.parse(f.commence_time);
    const evs = [...new Map([ymd(t - 6 * 3600e3), ymd(t)].flatMap((d) => paths.get(`${p}|${d}`) ?? []).map((e: any) => [e.id, e])).values()];
    const m = evs.filter((e: any) => {
      if (Math.abs(Date.parse(e.date) - t) > 6 * 3600e3) return false;
      const c = e.competitions?.[0]?.competitors ?? [];
      const h = c.find((x: any) => x.homeAway === "home"), a = c.find((x: any) => x.homeAway === "away");
      return h && a && sameTeam(f.home_team, h.team?.displayName ?? "") && sameTeam(f.away_team, a.team?.displayName ?? "");
    });
    if (m.length !== 1) continue;
    const e = m[0], c = e.competitions[0].competitors;
    const h = c.find((x: any) => x.homeAway === "home"), a = c.find((x: any) => x.homeAway === "away");
    scores[f.id] = { h: parseInt(h.score, 10), a: parseInt(a.score, 10), state: e.status?.type?.state, detail: e.status?.type?.shortDetail ?? "" };
  }
  return new Response(JSON.stringify({ scores, at: new Date().toISOString() }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
