import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Backtest de "comparar cuotas": sin modelo propio. Precio justo = cuota de
// Pinnacle sin margen (Shin). Se "apuesta" cuando otra cuota paga mas que ese
// precio justo: EV = cuota * prob_justa - 1. Solo lee CSV publicos de
// football-data.co.uk; no escribe nada.
//
// Dos precios de apuesta, para no engañarnos:
//   - "max": la MEJOR cuota entre todas las casas (MaxC*). Optimista: incluye
//     casas a las que quizas no tienes acceso o cuotas que duran segundos.
//   - "avg": la cuota PROMEDIO del mercado (AvgC*). Pesimista: una casa tipica.
// Cuotas al cierre (C) para que Pinnacle y el precio sean del mismo momento.
//
// body: { leagues: ["E0", "new:BRA", ...], seasons: [...] }

const MAIN_SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526", "2627"];

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}
function triple(r: Record<string, string>, a: string, b: string, c: string): number[] | null {
  const x = [num(r[a]), num(r[b]), num(r[c])];
  return x.every((v) => v != null) ? (x as number[]) : null;
}
function rowsOf(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => { const cols = line.split(","); const r: Record<string, string> = {}; header.forEach((h, j) => (r[h] = cols[j])); return r; });
}
async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  throw new Error("descarga fallida " + url);
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

const BUCKETS: [string, number, number][] = [["0-2%", 0, 0.02], ["2-5%", 0.02, 0.05], ["5-10%", 0.05, 0.10], ["10%+", 0.10, 99]];
type B = { n: number; won: number; profit: number; oddsSum: number };
const nb = (): B => ({ n: 0, won: 0, profit: 0, oddsSum: 0 });
const finB = (b: B) => ({ bets: b.n, roi: b.n ? +(b.profit / b.n).toFixed(4) : null, hit: b.n ? +(b.won / b.n).toFixed(3) : null, avgOdds: b.n ? +(b.oddsSum / b.n).toFixed(2) : null });

Deno.serve(async (req: Request) => {
  let cfg: any = {};
  try { cfg = await req.json(); } catch (_e) { /* defaults */ }
  const leagues: string[] = cfg.leagues ?? ["E0"];
  const seasons: string[] = cfg.seasons ?? MAIN_SEASONS;
  const out: Record<string, any> = {};
  const errors: string[] = [];

  for (const id of leagues) {
    const rows: Record<string, string>[] = [];
    try {
      if (id.startsWith("new:")) {
        const t = await fetchText(`https://www.football-data.co.uk/new/${id.slice(4)}.csv`);
        if (t) rows.push(...rowsOf(t).filter((r) => (r.Season ?? "") >= (cfg.minSeason ?? "2019")));
      } else {
        for (const s of seasons) { const t = await fetchText(`https://www.football-data.co.uk/mmz4281/${s}/${id}.csv`); if (t) rows.push(...rowsOf(t)); }
      }
    } catch (e) { errors.push(`${id}: ${String(e).slice(0, 100)}`); continue; }

    const res: Record<string, Record<string, B>> = { max: {}, avg: {} };
    for (const k of ["max", "avg"]) for (const [bk] of BUCKETS) res[k][bk] = nb();
    let used = 0;
    for (const r of rows) {
      const hg = parseInt(r.FTHG ?? r.HG, 10), ag = parseInt(r.FTAG ?? r.AG, 10);
      if (Number.isNaN(hg) || Number.isNaN(ag)) continue;
      const pin = triple(r, "PSCH", "PSCD", "PSCA");
      const mx = triple(r, "MaxCH", "MaxCD", "MaxCA");
      const av = triple(r, "AvgCH", "AvgCD", "AvgCA");
      if (!pin || !mx || !av) continue;
      used++;
      const fair = shin(pin);
      const y = hg > ag ? 0 : hg === ag ? 1 : 2;
      for (const [k, price] of [["max", mx], ["avg", av]] as [string, number[]][]) {
        for (let i = 0; i < 3; i++) {
          const ev = price[i] * fair[i] - 1;
          const bk = BUCKETS.find(([, lo, hi]) => ev >= lo && ev < hi);
          if (!bk) continue;
          const b = res[k][bk[0]]; b.n++; b.oddsSum += price[i];
          if (i === y) { b.won++; b.profit += price[i] - 1; } else b.profit -= 1;
        }
      }
    }
    out[id] = { matches: used, max: Object.fromEntries(Object.entries(res.max).map(([k, v]) => [k, finB(v)])), avg: Object.fromEntries(Object.entries(res.avg).map(([k, v]) => [k, finB(v)])) };
  }
  return new Response(JSON.stringify({ ok: true, errors, results: out }), { headers: { "Content-Type": "application/json" } });
});
