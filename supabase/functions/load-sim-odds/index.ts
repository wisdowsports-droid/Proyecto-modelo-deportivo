import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Carga las cuotas historicas (football-data.co.uk) de los partidos de la
// simulacion en la tabla sim_odds, para medir rentabilidad (ROI) del modelo.
// No toca sim_forecasts. body: { leagues: ["E0","SP1","new:BRA",...] }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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
const SEASONS = ["2324", "2425", "2526", "2627"];

function num(v?: string) { const n = parseFloat(v ?? ""); return Number.isFinite(n) && n > 1 ? n : null; }
function parseDate(d: string) {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/); if (!m) return null;
  let [, dd, mm, yy] = m; if (yy.length === 2) yy = "20" + yy; return `${yy}-${mm}-${dd}`;
}
function rowsOf(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => { const c = line.split(","); const r: Record<string, string> = {}; header.forEach((h, j) => (r[h] = c[j])); return r; });
}
async function fetchText(url: string) {
  for (let i = 0; i < 4; i++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  return null;
}
const pick = (r: Record<string, string>, ...keys: string[]) => { for (const k of keys) { const v = num(r[k]); if (v != null) return v; } return null; };

function toRow(r: Record<string, string>, label: string) {
  const date = parseDate(r.Date);
  const home = (r.HomeTeam ?? r.Home)?.trim(), away = (r.AwayTeam ?? r.Away)?.trim();
  if (!date || !home || !away) return null;
  return {
    league: label, match_date: date, home_team: home, away_team: away,
    hg: Number.isNaN(parseInt(r.FTHG ?? r.HG, 10)) ? null : parseInt(r.FTHG ?? r.HG, 10),
    ag: Number.isNaN(parseInt(r.FTAG ?? r.AG, 10)) ? null : parseInt(r.FTAG ?? r.AG, 10),
    avg_h: pick(r, "AvgH", "PSH", "B365H"), avg_d: pick(r, "AvgD", "PSD", "B365D"), avg_a: pick(r, "AvgA", "PSA", "B365A"),
    max_h: pick(r, "MaxH"), max_d: pick(r, "MaxD"), max_a: pick(r, "MaxA"),
    cl_h: pick(r, "AvgCH", "PSCH", "B365CH"), cl_d: pick(r, "AvgCD", "PSCD", "B365CD"), cl_a: pick(r, "AvgCA", "PSCA", "B365CA"),
    avg_o25: pick(r, "Avg>2.5", "P>2.5", "B365>2.5"), avg_u25: pick(r, "Avg<2.5", "P<2.5", "B365<2.5"),
    max_o25: pick(r, "Max>2.5"), max_u25: pick(r, "Max<2.5"),
    cl_o25: pick(r, "AvgC>2.5", "PC>2.5", "B365C>2.5"), cl_u25: pick(r, "AvgC<2.5", "PC<2.5", "B365C<2.5"),
    // Pinnacle (la casa mas precisa), Bet365 (casa blanda tipica) y mejores cuotas de cierre
    ps_h: pick(r, "PSH"), ps_d: pick(r, "PSD"), ps_a: pick(r, "PSA"),
    psc_h: pick(r, "PSCH"), psc_d: pick(r, "PSCD"), psc_a: pick(r, "PSCA"),
    b365_h: pick(r, "B365H"), b365_d: pick(r, "B365D"), b365_a: pick(r, "B365A"),
    maxc_h: pick(r, "MaxCH"), maxc_d: pick(r, "MaxCD"), maxc_a: pick(r, "MaxCA"),
    ps_o25: pick(r, "P>2.5"), ps_u25: pick(r, "P<2.5"),
    psc_o25: pick(r, "PC>2.5"), psc_u25: pick(r, "PC<2.5"),
    maxc_o25: pick(r, "MaxC>2.5"), maxc_u25: pick(r, "MaxC<2.5"),
  };
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const ids: string[] = body.leagues ?? Object.keys(LABELS);
  const out: any[] = [];
  for (const id of ids) {
    const label = LABELS[id]; if (!label) { out.push({ id, error: "desconocida" }); continue; }
    const rows: any[] = [];
    if (id.startsWith("new:")) {
      const text = await fetchText(`https://www.football-data.co.uk/new/${id.slice(4)}.csv`);
      if (text) for (const r of rowsOf(text)) { const x = toRow(r, label); if (x && x.match_date >= "2023-01-01") rows.push(x); }
    } else {
      for (const s of SEASONS) {
        const text = await fetchText(`https://www.football-data.co.uk/mmz4281/${s}/${id}.csv`);
        if (text) for (const r of rowsOf(text)) { const x = toRow(r, label); if (x) rows.push(x); }
      }
    }
    const uniq = new Map<string, any>(); for (const r of rows) uniq.set(`${r.match_date}|${r.home_team}|${r.away_team}`, r);
    const list = [...uniq.values()];
    let error: string | null = null;
    for (let i = 0; i < list.length && !error; i += 500) {
      const r = await supabase.from("sim_odds").upsert(list.slice(i, i + 500));
      if (r.error) error = r.error.message;
    }
    out.push({ id, rows: list.length, error });
  }
  return new Response(JSON.stringify({ ok: true, out }, null, 1), { headers: { "Content-Type": "application/json" } });
});
