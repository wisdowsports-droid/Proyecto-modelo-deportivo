import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// API-Football (plan gratis: 100 consultas/dia, solo fechas de hoy a +2 dias).
// Cada corrida (cron cada 15 min) hace, en este orden y sin pasar de 90 consultas al dia:
//  1. Dos veces al dia: partidos de hoy y manana (fixtures?date=) y los enlaza con los nuestros
//     (misma hora +-3 h y mismos equipos). Solo se guardan los enlazados.
//  2. Alineaciones: entre 55 y 5 min antes del partido (hasta 3 intentos).
//  3. Estadisticas finales (corners, tarjetas, tiros, posesion): 2 h 15 despues del inicio (hasta 4 intentos).
//  4. Bajas (lesionados/sancionados): en las 4 h previas.
//  5. Prediccion de API-Football (para compararnos con ellos): en las 30 h previas.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const KEY = Deno.env.get("API_FOOTBALL_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const DAILY_CAP = 90;
const PER_RUN = 8; // el plan gratis tambien limita consultas por minuto

const STOP = new Set(["fc", "cf", "sc", "ac", "as", "cd", "ud", "rc", "sd", "club", "de", "del", "la", "el", "the", "atletico", "deportivo", "ca", "cs", "ec", "se", "sp", "rj", "mg", "ba", "pr", "united", "city"]);
function tokens(name: string): string[] {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.\-()'/&]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}
function sameTeam(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return a.toLowerCase() === b.toLowerCase();
  for (const x of A) for (const y of B) {
    if (x === y && x.length >= 3) return true;
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  }
  return false;
}
const pct = (s: any) => { const n = parseFloat(String(s ?? "").replace("%", "")); return Number.isNaN(n) ? null : n / 100; };
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

Deno.serve(async (_req: Request) => {
  const t0 = Date.now();
  const today = ymd(Date.now());
  let { data: usage } = await supabase.from("apif_usage").select("*").eq("day", today).maybeSingle();
  if (!usage) { await supabase.from("apif_usage").insert({ day: today }); usage = { day: today, calls: 0, meta: {} }; }
  let calls: number = usage.calls; const meta: any = usage.meta ?? {}; let runCalls = 0;
  const log: string[] = [];

  const api = async (path: string) => {
    if (calls >= DAILY_CAP || runCalls >= PER_RUN) return null;
    if (runCalls > 0) await new Promise((res) => setTimeout(res, 800));
    calls++; runCalls++;
    try {
      const r = await fetch(`https://v3.football.api-sports.io/${path}`, { headers: { "x-apisports-key": KEY } });
      const j = await r.json();
      const errs = j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length);
      if (errs) { log.push(`${path}: ${JSON.stringify(j.errors)}`); return null; }
      return j.response ?? [];
    } catch (e) { log.push(`${path}: ${e}`); return null; }
  };

  // 1. listado y enlace (manana y tarde UTC)
  const slot = `${today}_${new Date().getUTCHours() < 14 ? "a" : "b"}`;
  if (!meta[slot]) {
    const { data: ours } = await supabase.from("fixtures").select("id, home_team, away_team, commence_time")
      .eq("sport", "soccer").gt("commence_time", new Date(Date.now() - 3 * 3600e3).toISOString())
      .lt("commence_time", new Date(Date.now() + 50 * 3600e3).toISOString());
    const { data: known } = await supabase.from("apif_fixtures").select("apif_id");
    const seen = new Set((known ?? []).map((k: any) => Number(k.apif_id)));
    let linked = 0;
    for (const d of [today, ymd(Date.now() + 86400e3)]) {
      const list = await api(`fixtures?date=${d}`);
      if (!list) continue;
      const rows: any[] = [];
      for (const x of list) {
        if (seen.has(x.fixture.id)) continue;
        const k = Date.parse(x.fixture.date);
        const m = (ours ?? []).filter((o: any) => Math.abs(Date.parse(o.commence_time) - k) <= 3 * 3600e3 &&
          sameTeam(o.home_team, x.teams.home.name) && sameTeam(o.away_team, x.teams.away.name));
        if (m.length !== 1) continue;
        rows.push({
          apif_id: x.fixture.id, fixture_id: m[0].id, league_id: x.league.id, league: x.league.name, country: x.league.country,
          kickoff: x.fixture.date, home: x.teams.home.name, away: x.teams.away.name, status: x.fixture.status.short,
        });
      }
      if (rows.length) { await supabase.from("apif_fixtures").upsert(rows); linked += rows.length; }
    }
    meta[slot] = true; log.push(`enlazados ${linked}`);
  }

  const now = Date.now(), iso = (t: number) => new Date(t).toISOString();
  const touch = async (id: number, upd: any) => { await supabase.from("apif_fixtures").update({ ...upd, updated_at: new Date().toISOString() }).eq("apif_id", id); };

  // 2. alineaciones
  const { data: lu } = await supabase.from("apif_fixtures").select("apif_id, lineups_tries").is("lineups_at", null).lt("lineups_tries", 3)
    .gt("kickoff", iso(now + 5 * 60e3)).lt("kickoff", iso(now + 55 * 60e3)).order("kickoff");
  for (const f of lu ?? []) {
    const r = await api(`fixtures/lineups?fixture=${f.apif_id}`); if (r === null) break;
    if (r.length) {
      await touch(f.apif_id, { lineups_at: new Date().toISOString(), lineups_tries: f.lineups_tries + 1, lineups: r.map((t: any) => ({
        team: t.team?.name, formation: t.formation, coach: t.coach?.name,
        xi: (t.startXI ?? []).map((p: any) => p.player?.name), subs: (t.substitutes ?? []).length })) });
    } else await touch(f.apif_id, { lineups_tries: f.lineups_tries + 1 });
  }

  // 3. estadisticas finales
  const { data: st } = await supabase.from("apif_fixtures").select("apif_id, stats_tries").is("stats_at", null).lt("stats_tries", 4)
    .lt("kickoff", iso(now - 135 * 60e3)).gt("kickoff", iso(now - 2 * 86400e3)).order("kickoff");
  for (const f of st ?? []) {
    const r = await api(`fixtures/statistics?fixture=${f.apif_id}`); if (r === null) break;
    if (r.length >= 2) {
      const obj = (t: any) => Object.fromEntries((t.statistics ?? []).map((s: any) => [s.type, s.value]));
      await touch(f.apif_id, { stats_at: new Date().toISOString(), stats_tries: f.stats_tries + 1,
        stats: { home: obj(r[0]), away: obj(r[1]), teams: [r[0].team?.name, r[1].team?.name] } });
    } else await touch(f.apif_id, { stats_tries: f.stats_tries + 1 });
  }

  // 4. bajas
  const { data: inj } = await supabase.from("apif_fixtures").select("apif_id").is("injuries_at", null)
    .gt("kickoff", iso(now)).lt("kickoff", iso(now + 4 * 3600e3)).order("kickoff");
  for (const f of inj ?? []) {
    const r = await api(`injuries?fixture=${f.apif_id}`); if (r === null) break;
    await touch(f.apif_id, { injuries_at: new Date().toISOString(), injuries: r.map((x: any) => ({
      team: x.team?.name, player: x.player?.name, type: x.player?.type, reason: x.player?.reason })) });
  }

  // 5. prediccion de API-Football (referencia)
  const { data: pr } = await supabase.from("apif_fixtures").select("apif_id").is("pred_at", null)
    .gt("kickoff", iso(now + 10 * 60e3)).lt("kickoff", iso(now + 30 * 3600e3)).order("kickoff").limit(12);
  for (const f of pr ?? []) {
    if (calls >= DAILY_CAP - 10) break; // deja margen para alineaciones y estadisticas
    const r = await api(`predictions?fixture=${f.apif_id}`); if (r === null) break;
    const p = r[0]?.predictions;
    await touch(f.apif_id, { pred_at: new Date().toISOString(), pred_home: pct(p?.percent?.home), pred_draw: pct(p?.percent?.draw),
      pred_away: pct(p?.percent?.away), pred_advice: p?.advice ?? null, pred_under_over: p?.under_over ?? null });
  }

  await supabase.from("apif_usage").update({ calls, meta }).eq("day", today);
  return new Response(JSON.stringify({ ok: true, calls_today: calls, log, ms: Date.now() - t0 }, null, 1),
    { headers: { "Content-Type": "application/json" } });
});
