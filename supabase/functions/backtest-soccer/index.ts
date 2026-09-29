import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Backtest walk-forward del modelo de futbol (el mismo Poisson que usa
// produccion: refit_team_strengths_from_history + soccer_match_probs).
// Solo LEE los CSV publicos de football-data.co.uk (que traen cuotas) y
// devuelve un resumen -- no escribe nada en la base.
//
// Para cada partido se entrena SOLO con lo que se sabia antes de jugarse:
// temporada anterior completa + temporada actual hasta el dia anterior
// (misma ventana que usa produccion: 2 temporadas). Luego se compara contra
// el mercado: Pinnacle al cierre (el mercado mas eficiente) sin margen.
//
// ligas: codigos "main" (E0, E1, SC0...) o "new:BRA", "new:ARG"... ; inventory:true solo lista datos
// body opcional: { preset, override, leagues, seasons, lastN, inventory }

const ALL_LEAGUES: Record<string, string> = { E0: "EPL", SP1: "La Liga", I1: "Serie A", D1: "Bundesliga", F1: "Ligue 1" };
const ALL_SEASONS = ["1819", "1920", "2021", "2122", "2223", "2324", "2425", "2526", "2627"];

type Match = {
  league: string; season: string; date: string; home: string; away: string; hg: number; ag: number;
  pre: number[] | null; close: number[] | null; closeAvg: number[] | null; ouPre: number[] | null; ouClose: number[] | null;
};

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}
function triple(r: Record<string, string>, a: string, b: string, c: string): number[] | null {
  const x = [num(r[a]), num(r[b]), num(r[c])];
  return x.every((v) => v != null) ? (x as number[]) : null;
}
function pair(r: Record<string, string>, a: string, b: string): number[] | null {
  const x = [num(r[a]), num(r[b])];
  return x.every((v) => v != null) ? (x as number[]) : null;
}
function parseDate(d: string): string | null {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = "20" + yy;
  return `${yy}-${mm}-${dd}`;
}

function rowsOf(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => { const cols = line.split(","); const r: Record<string, string> = {}; header.forEach((h, j) => (r[h] = cols[j])); return r; });
}
function toMatch(r: Record<string, string>, league: string, season: string): Match | null {
  const date = parseDate(r.Date);
  const home = r.HomeTeam ?? r.Home, away = r.AwayTeam ?? r.Away;
  const hg = parseInt(r.FTHG ?? r.HG, 10), ag = parseInt(r.FTAG ?? r.AG, 10);
  if (!date || !home || !away || Number.isNaN(hg) || Number.isNaN(ag)) return null;
  return {
    league, season, date, home, away, hg, ag,
    pre: triple(r, "AvgH", "AvgD", "AvgA"),
    close: triple(r, "PSCH", "PSCD", "PSCA") ?? triple(r, "AvgCH", "AvgCD", "AvgCA"),
    closeAvg: triple(r, "AvgCH", "AvgCD", "AvgCA"),
    ouPre: pair(r, "Avg>2.5", "Avg<2.5"),
    ouClose: pair(r, "PC>2.5", "PC<2.5") ?? pair(r, "AvgC>2.5", "AvgC<2.5"),
  };
}
async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  throw new Error("descarga fallida " + url);
}
// Devuelve { temporada -> partidos } de una liga, temporadas en orden.
async function loadLeague(id: string, mainSeasons: string[]): Promise<Record<string, Match[]>> {
  const out: Record<string, Match[]> = {};
  if (id.startsWith("new:")) {
    const code = id.slice(4);
    const text = await fetchText(`https://www.football-data.co.uk/new/${code}.csv`);
    if (!text) return out;
    for (const r of rowsOf(text)) {
      const season = (r.Season ?? "").trim();
      const m = toMatch(r, code, season);
      if (m) (out[season] ??= []).push(m);
    }
  } else {
    for (const s of mainSeasons) {
      const text = await fetchText(`https://www.football-data.co.uk/mmz4281/${s}/${id}.csv`);
      if (!text) continue;
      const ms = rowsOf(text).map((r) => toMatch(r, ALL_LEAGUES[id] ?? id, s)).filter((m): m is Match => m != null);
      if (ms.length) out[s] = ms;
    }
  }
  return out;
}

// ---- modelo (replica de produccion) ----
function fit(games: Match[], minGames = 3) {
  if (!games.length) return null;
  let sh = 0, sa = 0;
  const t: Record<string, { s: number; c: number; n: number }> = {};
  for (const g of games) {
    sh += g.hg; sa += g.ag;
    (t[g.home] ??= { s: 0, c: 0, n: 0 }); (t[g.away] ??= { s: 0, c: 0, n: 0 });
    t[g.home].s += g.hg; t[g.home].c += g.ag; t[g.home].n++;
    t[g.away].s += g.ag; t[g.away].c += g.hg; t[g.away].n++;
  }
  const avgHome = sh / games.length, avgAway = sa / games.length, avgGoals = (avgHome + avgAway) / 2;
  const teams: Record<string, { att: number; def: number }> = {};
  for (const [k, v] of Object.entries(t)) if (v.n >= minGames) teams[k] = { att: v.s / v.n / avgGoals, def: v.c / v.n / avgGoals };
  return { avgHome, avgAway, teams };
}

type Cfg = { name: string; iter: boolean; H: number | null; k: number; promoted: boolean; rho: number; blend: number | null; seasonsBack: number };
const PRESETS: Record<string, Cfg> = {
  base:        { name: "base", iter: false, H: null, k: 0, promoted: false, rho: 0, blend: null, seasonsBack: 1 },
  iter:        { name: "iter", iter: true, H: null, k: 0, promoted: false, rho: 0, blend: null, seasonsBack: 1 },
  iter_decay:  { name: "iter_decay", iter: true, H: 180, k: 0, promoted: false, rho: 0, blend: null, seasonsBack: 2 },
  iter_shrink: { name: "iter_shrink", iter: true, H: 180, k: 4, promoted: true, rho: 0, blend: null, seasonsBack: 2 },
  full:        { name: "full", iter: true, H: 180, k: 4, promoted: true, rho: -0.08, blend: null, seasonsBack: 2 },
};

type Fit = { mh: number; ma: number; att: Record<string, number>; def: Record<string, number> };
// Poisson multiplicativo ajustado por rival (Maher), con peso por antiguedad
// (vida media H dias), encogimiento hacia 1 (k partidos "ficticios") y prior
// mas debil para recien ascendidos (no estaban la temporada anterior).
function fitIter(games: Match[], asOf: string, cfg: Cfg, prevTeams: Set<string>, warm: Fit | null): Fit {
  const t0 = Date.parse(asOf);
  const w = games.map((g) => cfg.H ? Math.exp(-Math.LN2 * (t0 - Date.parse(g.date)) / 86400000 / cfg.H) : 1);
  const teams = new Set<string>(); for (const g of games) { teams.add(g.home); teams.add(g.away); }
  let sw = 0, sh = 0, sa = 0; games.forEach((g, i) => { sw += w[i]; sh += w[i] * g.hg; sa += w[i] * g.ag; });
  const m = (sh + sa) / sw / 2;
  const att: Record<string, number> = {}, def: Record<string, number> = {}, pa: Record<string, number> = {}, pd: Record<string, number> = {};
  for (const tm of teams) {
    const promo = cfg.promoted && prevTeams.size > 0 && !prevTeams.has(tm);
    pa[tm] = promo ? 0.85 : 1; pd[tm] = promo ? 1.15 : 1;
    att[tm] = warm?.att[tm] ?? pa[tm]; def[tm] = warm?.def[tm] ?? pd[tm];
  }
  let mh = warm?.mh ?? sh / sw, ma = warm?.ma ?? sa / sw;
  const iters = warm ? 3 : 8;
  for (let it = 0; it < iters; it++) {
    const S: Record<string, number> = {}, E: Record<string, number> = {}, C: Record<string, number> = {}, F: Record<string, number> = {};
    for (const tm of teams) { S[tm] = 0; E[tm] = 0; C[tm] = 0; F[tm] = 0; }
    games.forEach((g, i) => {
      const wi = w[i];
      S[g.home] += wi * g.hg; E[g.home] += wi * mh * def[g.away];
      S[g.away] += wi * g.ag; E[g.away] += wi * ma * def[g.home];
      C[g.home] += wi * g.ag; F[g.home] += wi * ma * att[g.away];
      C[g.away] += wi * g.hg; F[g.away] += wi * mh * att[g.home];
    });
    const km = cfg.k * m;
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
function tau(i: number, j: number, lh: number, la: number, rho: number) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}
function probs(lh: number, la: number, rho = 0) {
  let h = 0, d = 0, a = 0, over = 0, tot = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lh) * pois(j, la) * (rho ? Math.max(tau(i, j, lh, la, rho), 0) : 1); tot += p;
    if (i > j) h += p; else if (i === j) d += p; else a += p;
    if (i + j > 2.5) over += p;
  }
  return { x: [h / tot, d / tot, a / tot], over: over / tot };
}

// ---- mercado sin margen ----
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
function blend(p: number[], q: number[], wgt: number) {
  const r = p.map((v, i) => Math.pow(Math.max(v, 1e-9), wgt) * Math.pow(Math.max(q[i], 1e-9), 1 - wgt));
  const s = r.reduce((a, b) => a + b, 0); return r.map((v) => v / s);
}
function mult(odds: number[]) { const p = odds.map((o) => 1 / o), t = p.reduce((a, b) => a + b, 0); return p.map((v) => v / t); }

type Acc = { n: number; ll: number; br: number };
const acc = (): Acc => ({ n: 0, ll: 0, br: 0 });
function score(a: Acc, p: number[], y: number) {
  a.n++; a.ll += -Math.log(Math.max(p[y], 1e-12));
  a.br += p.reduce((s, v, i) => s + (v - (i === y ? 1 : 0)) ** 2, 0);
}
const fin = (a: Acc) => ({ n: a.n, logloss: +(a.ll / a.n).toFixed(4), brier: +(a.br / a.n).toFixed(4) });

type Bets = { n: number; won: number; profit: number; clv: number; clvN: number };
const bets = (): Bets => ({ n: 0, won: 0, profit: 0, clv: 0, clvN: 0 });
const BUCKETS: [string, number, number][] = [["0-3%", 0, 0.03], ["3-6%", 0.03, 0.06], ["6-10%", 0.06, 0.10], ["10%+", 0.10, 9]];
const finB = (b: Bets) => ({ bets: b.n, hit: b.n ? +(b.won / b.n).toFixed(3) : null, roi: b.n ? +(b.profit / b.n).toFixed(4) : null, clv: b.clvN ? +(b.clv / b.clvN).toFixed(4) : null });

Deno.serve(async (req: Request) => {
  let cfg: any = {};
  try { cfg = await req.json(); } catch (_e) { /* defaults */ }
  const codes: string[] = cfg.leagues ?? Object.keys(ALL_LEAGUES);
  const C: Cfg = { ...(PRESETS[cfg.preset ?? "base"] ?? PRESETS.base), ...(cfg.override ?? {}) };
  const tStart = Date.now();

  const mainSeasons: string[] = cfg.seasons ?? ALL_SEASONS;
  const data: Record<string, Record<string, Match[]>> = {};
  const loadErrors: string[] = [];
  for (const c of codes) {
    try { data[c] = await loadLeague(c, mainSeasons); if (!Object.keys(data[c]).length) loadErrors.push(`${c} sin datos`); }
    catch (e) { loadErrors.push(`${c}: ${String(e).slice(0, 120)}`); data[c] = {}; }
  }
  const seasonOrder = (c: string) => Object.keys(data[c] ?? {}).sort().slice(-(cfg.lastN ?? 99));
  if (cfg.inventory) {
    const inv: Record<string, any> = {};
    for (const c of codes) {
      const all = Object.values(data[c] ?? {}).flat();
      inv[c] = {
        seasons: Object.fromEntries(Object.keys(data[c] ?? {}).sort().map((k) => [k, data[c][k].length])),
        withPinnacleOrAvgClose: all.filter((m) => m.close).length, withPreOdds: all.filter((m) => m.pre).length,
        withOU: all.filter((m) => m.ouClose).length, total: all.length,
      };
    }
    return new Response(JSON.stringify({ ok: true, loadErrors, inventory: inv }), { headers: { "Content-Type": "application/json" } });
  }

  const model1x2 = acc(), market1x2 = acc(), modelOU = acc(), marketOU = acc();
  const perLeague: Record<string, { model: Acc; market: Acc }> = {};
  const perSeason: Record<string, { model: Acc; market: Acc }> = {};
  const b1x2: Record<string, Bets> = {}, bOU: Record<string, Bets> = {};
  for (const [k] of BUCKETS) { b1x2[k] = bets(); bOU[k] = bets(); }
  let skippedNoStrength = 0, skippedNoOdds = 0;

  for (const c of codes) {
    const seasons = seasonOrder(c);
    for (let si = 1; si < seasons.length; si++) {
      const prev = data[c]?.[seasons[si - 1]] ?? [], cur = (data[c]?.[seasons[si]] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const older: Match[] = [];
      for (let b = 2; b <= C.seasonsBack && si - b >= 0; b++) older.push(...(data[c]?.[seasons[si - b]] ?? []));
      const prevTeams = new Set<string>(); for (const g of prev) { prevTeams.add(g.home); prevTeams.add(g.away); }
      let warm: Fit | null = null;
      const byDate: Record<string, Match[]> = {};
      for (const m of cur) (byDate[m.date] ??= []).push(m);
      const dates = Object.keys(byDate).sort();
      const played: Match[] = [];
      for (const d of dates) {
        const model = fit([...prev, ...played]);
        const itFit = C.iter ? (warm = fitIter([...older, ...prev, ...played], d, C, prevTeams, warm)) : null;
        for (const m of byDate[d]) {
          const th = model?.teams[m.home], ta = model?.teams[m.away];
          if (!model || !th || !ta) { skippedNoStrength++; continue; }   // mismo conjunto de partidos para todas las variantes
          if (!m.close) { skippedNoOdds++; continue; }
          let lh = model.avgHome * th.att * ta.def, la = model.avgAway * ta.att * th.def;
          if (itFit) { lh = itFit.mh * itFit.att[m.home] * itFit.def[m.away]; la = itFit.ma * itFit.att[m.away] * itFit.def[m.home]; }
          const p = probs(lh, la, C.rho);
          if (C.blend != null && (m.pre ?? m.closeAvg)) p.x = blend(p.x, shin((m.pre ?? m.closeAvg)!), C.blend);
          if (C.blend != null && m.ouPre) { const q = mult(m.ouPre); const r = blend([p.over, 1 - p.over], q, C.blend); p.over = r[0]; }
          const y = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
          const mk = shin(m.close);
          score(model1x2, p.x, y); score(market1x2, mk, y);
          const L = (perLeague[m.league] ??= { model: acc(), market: acc() }); score(L.model, p.x, y); score(L.market, mk, y);
          const S = (perSeason[m.season] ??= { model: acc(), market: acc() }); score(S.model, p.x, y); score(S.market, mk, y);

          // apuestas simuladas 1X2 a la cuota promedio pre-partido
          const price = m.pre ?? m.closeAvg;
          if (price) {
            const fair = m.pre ? shin(m.pre) : mk;
            for (let i = 0; i < 3; i++) {
              const edge = p.x[i] - fair[i];
              const bk = BUCKETS.find(([, lo, hi]) => edge >= lo && edge < hi);
              if (!bk) continue;
              const B = b1x2[bk[0]]; B.n++;
              if (i === y) { B.won++; B.profit += price[i] - 1; } else B.profit -= 1;
              if (m.pre) { B.clv += mk[i] - fair[i]; B.clvN++; }
            }
          }
          // Over/Under 2.5
          const yo = m.hg + m.ag > 2.5 ? 0 : 1;
          const pou = [p.over, 1 - p.over];
          if (m.ouClose) {
            const mko = mult(m.ouClose);
            score(modelOU, pou, yo); score(marketOU, mko, yo);
            if (m.ouPre) {
              const fair = mult(m.ouPre);
              for (let i = 0; i < 2; i++) {
                const edge = pou[i] - fair[i];
                const bk = BUCKETS.find(([, lo, hi]) => edge >= lo && edge < hi);
                if (!bk) continue;
                const B = bOU[bk[0]]; B.n++;
                if (i === yo) { B.won++; B.profit += m.ouPre[i] - 1; } else B.profit -= 1;
                B.clv += mko[i] - fair[i]; B.clvN++;
              }
            }
          }
        }
        played.push(...byDate[d]);
      }
    }
  }

  const map = (o: Record<string, { model: Acc; market: Acc }>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { model: fin(v.model), market: fin(v.market) }]));
  return new Response(JSON.stringify({
    ok: true, config: C, elapsedMs: Date.now() - tStart, loadErrors, skippedNoStrength, skippedNoOdds,
    x12: { model: fin(model1x2), marketClose: fin(market1x2) },
    ou25: { model: fin(modelOU), marketClose: fin(marketOU) },
    perLeague: map(perLeague), perSeason: map(perSeason),
    valueBets1x2: Object.fromEntries(Object.entries(b1x2).map(([k, v]) => [k, finB(v)])),
    valueBetsOU25: Object.fromEntries(Object.entries(bOU).map(([k, v]) => [k, finB(v)])),
  }, null, 1), { headers: { "Content-Type": "application/json" } });
});
