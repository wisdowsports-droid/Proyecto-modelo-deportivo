import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Simulacion con temporadas pasadas (walk-forward) -> tabla sim_forecasts.
// Cada partido se pronostica SOLO con lo que se sabia antes de su fecha:
// el modelo se reentrena dia a dia con los partidos ya jugados y se mezcla
// con las cuotas promedio PREVIAS al partido (no las de cierre), igual que
// en produccion (modelo^0.3 * mercado^0.7). Luego se compara con el
// resultado real. Sirve para mostrar como le habria ido al pronosticador;
// se muestra separado de los resultados reales (forecast_log).
//
// body: { league: "E0" | "new:BRA" ..., seasons?: 3 }  (una liga por llamada, limite de CPU)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// codigo football-data -> etiqueta de liga en nuestra base
const LABELS: Record<string, string> = {
  E0: "EPL", SP1: "La Liga - Spain", I1: "Serie A - Italy", D1: "Bundesliga - Germany", F1: "Ligue 1 - France",
  E1: "Championship - England", E2: "League One - England", SC0: "Premiership - Scotland",
  D2: "2. Bundesliga - Germany", I2: "Serie B - Italy", SP2: "La Liga 2 - Spain", F2: "Ligue 2 - France",
  N1: "Eredivisie - Netherlands", B1: "Pro League - Belgium", P1: "Primeira Liga - Portugal",
  T1: "Super Lig - Turkey", G1: "Super League - Greece",
  "new:ARG": "Primera División - Argentina", "new:BRA": "Brazil Série A", "new:MEX": "Liga MX", "new:USA": "MLS",
  "new:AUT": "Bundesliga - Austria", "new:DNK": "Superliga - Denmark", "new:NOR": "Eliteserien - Norway",
  "new:SWE": "Allsvenskan - Sweden", "new:SWZ": "Super League - Switzerland", "new:POL": "Ekstraklasa - Poland",
  "new:JPN": "J1 League - Japan",
};
const MAIN_SEASONS = ["2122", "2223", "2324", "2425", "2526", "2627"];

// misma configuracion que produccion (refit_team_strengths_from_history v2)
const H = 365, K = 4, RHO = -0.08, W_MODEL = 0.3, SEASONS_BACK = 2;

type Match = { season: string; date: string; home: string; away: string; hg: number; ag: number; pre: number[] | null; closing: boolean };

function num(v?: string) { const n = parseFloat(v ?? ""); return Number.isFinite(n) && n > 1 ? n : null; }
function triple(r: Record<string, string>, a: string, b: string, c: string) {
  const x = [num(r[a]), num(r[b]), num(r[c])]; return x.every((v) => v != null) ? (x as number[]) : null;
}
function parseDate(d: string) {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/); if (!m) return null;
  let [, dd, mm, yy] = m; if (yy.length === 2) yy = "20" + yy; return `${yy}-${mm}-${dd}`;
}
function rowsOf(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => { const c = line.split(","); const r: Record<string, string> = {}; header.forEach((h, j) => (r[h] = c[j])); return r; });
}
function toMatch(r: Record<string, string>, season: string): Match | null {
  const date = parseDate(r.Date);
  const home = r.HomeTeam ?? r.Home, away = r.AwayTeam ?? r.Away;
  const hg = parseInt(r.FTHG ?? r.HG, 10), ag = parseInt(r.FTAG ?? r.AG, 10);
  if (!date || !home || !away || Number.isNaN(hg) || Number.isNaN(ag)) return null;
  // cuotas promedio PREVIAS al partido; si no hay, Pinnacle/B365 previas.
  // Las ligas "new" (Latam, MLS, nordicas, Japon) solo traen cuotas de
  // CIERRE (justo antes del inicio): se usan y se marca la fuente.
  const pre = triple(r, "AvgH", "AvgD", "AvgA") ?? triple(r, "PSH", "PSD", "PSA") ?? triple(r, "B365H", "B365D", "B365A");
  const close = pre ? null : (triple(r, "AvgCH", "AvgCD", "AvgCA") ?? triple(r, "PSCH", "PSCD", "PSCA"));
  return { season, date, home: home.trim(), away: away.trim(), hg, ag, pre: pre ?? close, closing: !pre && !!close };
}
async function fetchText(url: string) {
  for (let i = 0; i < 4; i++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  return null;
}
async function loadLeague(id: string): Promise<Record<string, Match[]>> {
  const out: Record<string, Match[]> = {};
  if (id.startsWith("new:")) {
    const text = await fetchText(`https://www.football-data.co.uk/new/${id.slice(4)}.csv`);
    if (!text) return out;
    for (const r of rowsOf(text)) { const s = (r.Season ?? "").trim(); const m = toMatch(r, s); if (m) (out[s] ??= []).push(m); }
  } else {
    for (const s of MAIN_SEASONS) {
      const text = await fetchText(`https://www.football-data.co.uk/mmz4281/${s}/${id}.csv`);
      if (!text) continue;
      const ms = rowsOf(text).map((r) => toMatch(r, s)).filter((m): m is Match => m != null);
      if (ms.length) out[s] = ms;
    }
  }
  return out;
}

type Fit = { mh: number; ma: number; att: Record<string, number>; def: Record<string, number> };
function fitIter(games: Match[], asOf: string, prevTeams: Set<string>, warm: Fit | null): Fit {
  const t0 = Date.parse(asOf);
  const w = games.map((g) => Math.exp(-Math.LN2 * (t0 - Date.parse(g.date)) / 86400000 / H));
  const teams = new Set<string>(); for (const g of games) { teams.add(g.home); teams.add(g.away); }
  let sw = 0, sh = 0, sa = 0; games.forEach((g, i) => { sw += w[i]; sh += w[i] * g.hg; sa += w[i] * g.ag; });
  const m = (sh + sa) / sw / 2;
  const att: Record<string, number> = {}, def: Record<string, number> = {}, pa: Record<string, number> = {}, pd: Record<string, number> = {};
  for (const tm of teams) {
    const promo = prevTeams.size > 0 && !prevTeams.has(tm);
    pa[tm] = promo ? 0.85 : 1; pd[tm] = promo ? 1.15 : 1;
    att[tm] = warm?.att[tm] ?? pa[tm]; def[tm] = warm?.def[tm] ?? pd[tm];
  }
  let mh = warm?.mh ?? sh / sw, ma = warm?.ma ?? sa / sw;
  for (let it = 0; it < (warm ? 3 : 8); it++) {
    const S: Record<string, number> = {}, E: Record<string, number> = {}, C: Record<string, number> = {}, F: Record<string, number> = {};
    for (const tm of teams) { S[tm] = 0; E[tm] = 0; C[tm] = 0; F[tm] = 0; }
    games.forEach((g, i) => {
      const wi = w[i];
      S[g.home] += wi * g.hg; E[g.home] += wi * mh * def[g.away];
      S[g.away] += wi * g.ag; E[g.away] += wi * ma * def[g.home];
      C[g.home] += wi * g.ag; F[g.home] += wi * ma * att[g.away];
      C[g.away] += wi * g.hg; F[g.away] += wi * mh * att[g.home];
    });
    const km = K * m;
    for (const tm of teams) { att[tm] = (S[tm] + km * pa[tm]) / (E[tm] + km); def[tm] = (C[tm] + km * pd[tm]) / (F[tm] + km); }
    let n = 0, sAtt = 0; for (const tm of teams) { sAtt += att[tm]; n++; }
    const norm = sAtt / n; for (const tm of teams) { att[tm] /= norm; def[tm] *= norm; }
    let nh = 0, dh = 0, na = 0, da = 0;
    games.forEach((g, i) => { nh += w[i] * g.hg; dh += w[i] * att[g.home] * def[g.away]; na += w[i] * g.ag; da += w[i] * att[g.away] * def[g.home]; });
    mh = nh / dh; ma = na / da;
  }
  return { mh, ma, att, def };
}

function pois(k: number, l: number) { if (l <= 0) return k === 0 ? 1 : 0; let lp = -l + k * Math.log(l); for (let i = 2; i <= k; i++) lp -= Math.log(i); return Math.exp(lp); }
function tau(i: number, j: number, lh: number, la: number) {
  if (i === 0 && j === 0) return 1 - lh * la * RHO;
  if (i === 0 && j === 1) return 1 + lh * RHO;
  if (i === 1 && j === 0) return 1 + la * RHO;
  if (i === 1 && j === 1) return 1 - RHO;
  return 1;
}
function forecast(lh: number, la: number) {
  let h = 0, d = 0, a = 0, over = 0, btts = 0, tot = 0, best = -1, th = 0, ta = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lh) * pois(j, la) * Math.max(tau(i, j, lh, la), 0); tot += p;
    if (i > j) h += p; else if (i === j) d += p; else a += p;
    if (i + j > 2.5) over += p;
    if (i > 0 && j > 0) btts += p;
    if (p > best) { best = p; th = i; ta = j; }
  }
  return { x: [h / tot, d / tot, a / tot], over: over / tot, btts: btts / tot, th, ta };
}
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
function blend(p: number[], q: number[]) {
  const r = p.map((v, i) => Math.pow(Math.max(v, 1e-9), W_MODEL) * Math.pow(Math.max(q[i], 1e-9), 1 - W_MODEL));
  const s = r.reduce((a, b) => a + b, 0); return r.map((v) => v / s);
}
const r4 = (v: number) => Math.round(v * 10000) / 10000;

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const id: string = body.league ?? "";
  const label = LABELS[id];
  if (!label) return new Response(JSON.stringify({ ok: false, error: `liga desconocida '${id}'`, validas: Object.keys(LABELS) }), { status: 400 });
  const nSim: number = body.seasons ?? 3;
  const tStart = Date.now();

  const data = await loadLeague(id);
  const seasons = Object.keys(data).sort();
  // las primeras temporadas solo entrenan; se simulan las ultimas nSim
  const simFrom = Math.max(1, seasons.length - nSim);
  const rows: any[] = [];
  let skipped = 0;

  for (let si = simFrom; si < seasons.length; si++) {
    const prev = data[seasons[si - 1]] ?? [];
    const older: Match[] = [];
    for (let b = 2; b <= SEASONS_BACK && si - b >= 0; b++) older.push(...(data[seasons[si - b]] ?? []));
    const prevTeams = new Set<string>(); for (const g of prev) { prevTeams.add(g.home); prevTeams.add(g.away); }
    const cur = (data[seasons[si]] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const byDate: Record<string, Match[]> = {};
    for (const m of cur) (byDate[m.date] ??= []).push(m);
    const played: Match[] = [];
    let warm: Fit | null = null;
    for (const d of Object.keys(byDate).sort()) {
      warm = fitIter([...older, ...prev, ...played], d, prevTeams, warm);
      for (const m of byDate[d]) {
        const ah = warm.att[m.home], dh = warm.def[m.home], aa = warm.att[m.away], da = warm.def[m.away];
        if (ah == null || aa == null) { skipped++; continue; }
        const f = forecast(warm.mh * ah * da, warm.ma * aa * dh);
        const x = m.pre ? blend(f.x, shin(m.pre)) : f.x;
        const best = x[0] >= x[1] && x[0] >= x[2] ? 0 : x[2] >= x[1] ? 2 : 1;
        const pick = ["Local", "Empate", "Visitante"][best];
        const pp = x[best];
        const y = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
        rows.push({
          league: label, season: m.season, match_date: m.date, home_team: m.home, away_team: m.away,
          source: !m.pre ? "modelo" : m.closing ? "modelo + mercado (cierre)" : "modelo + mercado",
          p_home: r4(x[0]), p_draw: r4(x[1]), p_away: r4(x[2]), pick, pick_prob: r4(pp),
          confidence: pp >= 0.6 ? "alta" : pp >= 0.45 ? "media" : "baja",
          over25: r4(f.over), btts: r4(f.btts), top_home: f.th, top_away: f.ta,
          home_score: m.hg, away_score: m.ag,
          hit_result: best === y, hit_over25: (f.over >= 0.5) === (m.hg + m.ag > 2.5),
          hit_btts: (f.btts >= 0.5) === (m.hg > 0 && m.ag > 0), hit_score: f.th === m.hg && f.ta === m.ag,
        });
      }
      played.push(...byDate[d]);
    }
  }

  // reemplaza la simulacion anterior de esta liga
  await supabase.from("sim_forecasts").delete().eq("league", label);
  let error: string | null = null;
  const uniq = new Map<string, any>();
  for (const r of rows) uniq.set(`${r.match_date}|${r.home_team}|${r.away_team}`, r);
  const list = [...uniq.values()];
  for (let i = 0; i < list.length && !error; i += 500) {
    const r = await supabase.from("sim_forecasts").insert(list.slice(i, i + 500));
    if (r.error) error = r.error.message;
  }
  const hits = list.filter((r) => r.hit_result).length;
  return new Response(JSON.stringify({
    ok: !error, league: label, seasonsSimulated: seasons.slice(simFrom), rows: list.length, skipped,
    hitRate: list.length ? +(hits / list.length).toFixed(3) : null, error, elapsedMs: Date.now() - tStart,
  }, null, 1), { headers: { "Content-Type": "application/json" } });
});
