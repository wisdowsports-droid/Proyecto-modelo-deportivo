import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Completa corners, tarjetas, tiros y faltas en results_history usando el
// resumen de cada partido de ESPN (gratis). Sirve para las ligas cuya fuente
// (football-data "new" o ESPN scoreboard) no trae esas estadisticas.
//  - Filas de ESPN (external_id espn_<code>_<eventId>): va directo al resumen.
//  - Filas de football-data (Argentina, Brasil, Mexico, MLS): busca el partido en
//    el scoreboard de ESPN por fecha (+-1 dia) y nombres de equipos.
// Marca stats_checked_at para no reintentar las que no encuentra.
// body: { league: "<etiqueta>", limit?: 120 }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };

const CODE: Record<string, string> = {
  "Liga BetPlay (Colombia Primera A)": "col.1", "Primera División - Uruguay": "uru.1", "Liga 1 - Peru": "per.1",
  "Primera División - Chile": "chi.1", "LigaPro - Ecuador": "ecu.1", "Primera División - Paraguay": "par.1",
  "Primera División - Argentina": "arg.1", "Brazil Série A": "bra.1", "Liga MX": "mex.1", "MLS": "usa.1",
};

const STOP = new Set(["fc", "cf", "sc", "ac", "as", "cd", "ud", "rc", "sd", "club", "de", "del", "la", "el", "the", "atletico", "deportivo", "ca", "cs", "ec", "se", "sp", "rj", "mg", "ba", "pr"]);
function tokens(name: string): string[] {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.\-()'/]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}
function sameTeam(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  for (const x of A) for (const y of B) {
    if (x === y && x.length >= 3) return true;
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  }
  return false;
}
async function getJson(url: string) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: HEADERS }); if (r.ok) return await r.json(); if (r.status === 404 || r.status === 400) return null; }
    catch (_e) { /* reintento */ }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  return null;
}
const sbCache = new Map<string, any[]>();
async function scoreboard(code: string, day: string) {
  const k = code + day; if (sbCache.has(k)) return sbCache.get(k)!;
  const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${day}`);
  const ev = d?.events ?? []; sbCache.set(k, ev); return ev;
}
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const num = (v: any) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const league: string = body.league, limit: number = body.limit ?? 120;
  const code = CODE[league];
  if (!code) return new Response(JSON.stringify({ ok: false, error: "liga sin codigo ESPN", validas: Object.keys(CODE) }), { status: 400 });
  const t0 = Date.now();
  const { data: rows, error } = await supabase.from("results_history")
    .select("id, external_id, match_date, home_team, away_team")
    .eq("league", league).eq("sport", "soccer").is("home_corners", null).is("stats_checked_at", null)
    .gt("match_date", new Date(Date.now() - 730 * 86400000).toISOString())
    .order("match_date", { ascending: false }).limit(limit);
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });

  let filled = 0, missing = 0;
  for (const r of rows ?? []) {
    if (Date.now() - t0 > 120000) break; // margen antes del limite de la funcion
    let eventId: string | null = null;
    const m = String(r.external_id ?? "").match(/^espn_[a-z0-9]+_(\d+)$/);
    if (m) eventId = m[1];
    else {
      const t = Date.parse(r.match_date);
      const cands = new Set<string>();
      for (const day of [ymd(t - 86400000), ymd(t), ymd(t + 86400000)]) {
        for (const e of await scoreboard(code, day)) {
          const comp = e.competitions?.[0];
          const h = comp?.competitors?.find((c: any) => c.homeAway === "home");
          const a = comp?.competitors?.find((c: any) => c.homeAway === "away");
          if (h && a && sameTeam(r.home_team, h.team?.displayName ?? "") && sameTeam(r.away_team, a.team?.displayName ?? "")) cands.add(e.id);
        }
      }
      if (cands.size === 1) eventId = [...cands][0];
    }
    let upd: any = { stats_checked_at: new Date().toISOString() };
    if (eventId) {
      const d = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/summary?event=${eventId}`);
      const teams = d?.boxscore?.teams ?? [];
      const H = teams.find((x: any) => x.homeAway === "home"), A = teams.find((x: any) => x.homeAway === "away");
      const st = (t: any, k: string) => num((t?.statistics ?? []).find((s: any) => s.name === k)?.displayValue);
      if (H && A && st(H, "wonCorners") != null && st(A, "wonCorners") != null) {
        upd = {
          ...upd,
          home_corners: st(H, "wonCorners"), away_corners: st(A, "wonCorners"),
          home_yellow: st(H, "yellowCards"), away_yellow: st(A, "yellowCards"),
          home_red: st(H, "redCards"), away_red: st(A, "redCards"),
          home_shots: st(H, "totalShots"), away_shots: st(A, "totalShots"),
          home_shots_on_target: st(H, "shotsOnTarget"), away_shots_on_target: st(A, "shotsOnTarget"),
          home_fouls: st(H, "foulsCommitted"), away_fouls: st(A, "foulsCommitted"),
        };
        filled++;
      } else missing++;
    } else missing++;
    await supabase.from("results_history").update(upd).eq("id", r.id);
  }
  const { count } = await supabase.from("results_history").select("*", { count: "exact", head: true })
    .eq("league", league).is("home_corners", null).is("stats_checked_at", null)
    .gt("match_date", new Date(Date.now() - 730 * 86400000).toISOString());
  return new Response(JSON.stringify({ ok: true, league, processed: (rows ?? []).length, filled, missing, pending: count, ms: Date.now() - t0 }, null, 1),
    { headers: { "Content-Type": "application/json" } });
});
