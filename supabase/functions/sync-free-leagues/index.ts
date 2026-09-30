import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Ligas extra 100% gratis (no gastan creditos de The Odds API).
// Todo sale de football-data.co.uk:
//   - historial: mmz4281/{temporada}/{codigo}.csv (ligas "main") y
//     new/{PAIS}.csv (ligas "new")
//   - proximos partidos + cuotas promedio del mercado: fixtures.csv y
//     new_league_fixtures.csv (solo traen la jornada de los proximos dias;
//     el sitio los publica antes de cada fecha, por eso corre a diario)
// Como historial y calendario usan los mismos nombres de equipo, no hace
// falta traducir nombres. Los partidos jugados se califican gratis con
// settle_fixtures_from_history. Objetivo: mas pronosticos por semana para
// construir el historial de aciertos mas rapido.
//
// body opcional { part: "main" | "new" | "fixtures" } para correr solo una
// parte (limite de CPU de la funcion). Sin body corre todo.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const MAIN: Record<string, string> = {
  E1: "Championship - England",
  E2: "League One - England",
  SC0: "Premiership - Scotland",
  D2: "2. Bundesliga - Germany",
  I2: "Serie B - Italy",
  SP2: "La Liga 2 - Spain",
  F2: "Ligue 2 - France",
  N1: "Eredivisie - Netherlands",
  B1: "Pro League - Belgium",
  P1: "Primeira Liga - Portugal",
  T1: "Super Lig - Turkey",
  G1: "Super League - Greece",
};
const MAIN_SEASONS = ["2526", "2627"];

// codigo del archivo new/ -> [pais como sale en new_league_fixtures.csv, etiqueta]
const NEW: Record<string, [string, string]> = {
  AUT: ["Austria", "Bundesliga - Austria"],
  DNK: ["Denmark", "Superliga - Denmark"],
  NOR: ["Norway", "Eliteserien - Norway"],
  SWE: ["Sweden", "Allsvenskan - Sweden"],
  SWZ: ["Switzerland", "Super League - Switzerland"],
  POL: ["Poland", "Ekstraklasa - Poland"],
  JPN: ["Japan", "J1 League - Japan"],
};
const NEW_SINCE_DAYS = 800;
const ALL_LABELS = [...Object.values(MAIN), ...Object.values(NEW).map((x) => x[1])];

function splitCsv(line: string, sep = ","): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseDate(d: string): string | null {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = "20" + yy;
  return `${yy}-${mm}-${dd}`;
}

const toInt = (v?: string) => { const n = parseInt(v ?? "", 10); return Number.isNaN(n) ? null : n; };
const toNum = (v?: string) => { const n = parseFloat(v ?? ""); return Number.isFinite(n) && n > 1 ? n : null; };

// football-data publica horas del Reino Unido: se convierten a UTC.
function ukToUtc(dateIso: string, time: string): string {
  const t = /^\d{1,2}:\d{2}$/.test(time ?? "") ? time.padStart(5, "0") : "15:00";
  const naive = new Date(`${dateIso}T${t}:00Z`);
  let offset = 0;
  try {
    const tz = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
      .formatToParts(naive).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = tz.match(/GMT([+-]\d+)/);
    if (m) offset = parseInt(m[1], 10);
  } catch (_e) { /* GMT */ }
  return new Date(naive.getTime() - offset * 3600000).toISOString();
}

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  return null;
}

function readCsv(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  // new_league_fixtures.csv viene separado por tabuladores
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const header = splitCsv(lines[0], sep);
  const ix = (...names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  return { rows: lines.slice(1).map((l) => splitCsv(l, sep)), ix };
}

async function upsert(table: string, rows: any[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict: "external_id" });
    if (error) return error.message;
  }
  return null;
}

async function historyMain() {
  const out: Record<string, any> = {};
  for (const [code, label] of Object.entries(MAIN)) {
    const byId = new Map<string, any>();
    for (const season of MAIN_SEASONS) {
      const text = await fetchText(`https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`);
      if (!text) continue;
      const { rows, ix } = readCsv(text);
      const c = {
        d: ix("Date"), h: ix("HomeTeam"), a: ix("AwayTeam"), hg: ix("FTHG"), ag: ix("FTAG"),
        hs: ix("HS"), as: ix("AS"), hst: ix("HST"), ast: ix("AST"), hc: ix("HC"), ac: ix("AC"),
        hy: ix("HY"), ay: ix("AY"), hr: ix("HR"), ar: ix("AR"), hf: ix("HF"), af: ix("AF"),
      };
      for (const r of rows) {
        const date = parseDate(r[c.d]);
        const hg = toInt(r[c.hg]), ag = toInt(r[c.ag]);
        if (!date || hg == null || ag == null || !r[c.h] || !r[c.a]) continue;
        const external_id = `fdcouk_${code}_${season}_${date}_${r[c.h]}_${r[c.a]}`.replace(/\s+/g, "-");
        byId.set(external_id, {
          external_id, sport: "soccer", league: label, match_date: date, season,
          home_team: r[c.h], away_team: r[c.a], home_score: hg, away_score: ag, source: "football-data.co.uk",
          home_shots: toInt(r[c.hs]), away_shots: toInt(r[c.as]),
          home_shots_on_target: toInt(r[c.hst]), away_shots_on_target: toInt(r[c.ast]),
          home_corners: toInt(r[c.hc]), away_corners: toInt(r[c.ac]),
          home_yellow: toInt(r[c.hy]), away_yellow: toInt(r[c.ay]),
          home_red: toInt(r[c.hr]), away_red: toInt(r[c.ar]),
          home_fouls: toInt(r[c.hf]), away_fouls: toInt(r[c.af]),
        });
      }
    }
    const rows = [...byId.values()];
    out[label] = { rows: rows.length, error: rows.length ? await upsert("results_history", rows) : "sin datos" };
  }
  return out;
}

async function historyNew() {
  const since = new Date(Date.now() - NEW_SINCE_DAYS * 86400000).toISOString().slice(0, 10);
  const out: Record<string, any> = {};
  for (const [code, [, label]] of Object.entries(NEW)) {
    const text = await fetchText(`https://www.football-data.co.uk/new/${code}.csv`);
    if (!text) { out[label] = { error: "descarga fallida" }; continue; }
    const { rows, ix } = readCsv(text);
    const iS = ix("Season"), iD = ix("Date"), iH = ix("Home"), iA = ix("Away"), iHG = ix("HG"), iAG = ix("AG");
    const byId = new Map<string, any>();
    for (const r of rows) {
      const date = parseDate(r[iD]);
      const hg = toInt(r[iHG]), ag = toInt(r[iAG]);
      if (!date || date < since || hg == null || ag == null || !r[iH] || !r[iA]) continue;
      const external_id = `fdnew_${code}_${date}_${r[iH]}_${r[iA]}`.replace(/\s+/g, "-");
      byId.set(external_id, {
        external_id, sport: "soccer", league: label, match_date: date, season: r[iS] || null,
        home_team: r[iH], away_team: r[iA], home_score: hg, away_score: ag, source: "football-data.co.uk",
      });
    }
    const list = [...byId.values()];
    out[label] = { rows: list.length, error: list.length ? await upsert("results_history", list) : "sin datos" };
  }
  return out;
}

async function upcomingFixtures() {
  const now = new Date().toISOString();
  const byId = new Map<string, any>();
  const out: Record<string, any> = {};

  const main = await fetchText("https://www.football-data.co.uk/fixtures.csv");
  if (main) {
    const { rows, ix } = readCsv(main);
    const iDiv = ix("Div"), iD = ix("Date"), iT = ix("Time"), iH = ix("HomeTeam"), iA = ix("AwayTeam");
    const oH = ix("AvgH", "PSH", "B365H"), oD = ix("AvgD", "PSD", "B365D"), oA = ix("AvgA", "PSA", "B365A");
    for (const r of rows) {
      const label = MAIN[r[iDiv]];
      const date = parseDate(r[iD]);
      if (!label || !date || !r[iH] || !r[iA]) continue;
      const external_id = `fdfix_${r[iDiv]}_${date}_${r[iH]}_${r[iA]}`.replace(/\s+/g, "-");
      byId.set(external_id, {
        external_id, sport: "soccer", league: label, home_team: r[iH], away_team: r[iA],
        commence_time: ukToUtc(date, r[iT]), status: "scheduled",
        odds_home: toNum(r[oH]), odds_draw: toNum(r[oD]), odds_away: toNum(r[oA]), odds_updated_at: now,
      });
    }
  } else out.mainError = "fixtures.csv no disponible";

  const nw = await fetchText("https://www.football-data.co.uk/new_league_fixtures.csv");
  if (nw) {
    const byCountry: Record<string, [string, string]> = {};
    for (const [code, [country, label]] of Object.entries(NEW)) byCountry[country] = [code, label];
    const { rows, ix } = readCsv(nw);
    const iC = ix("Country"), iD = ix("Date"), iT = ix("Time"), iH = ix("Home"), iA = ix("Away");
    const oH = ix("AvgH", "AvgCH", "PSH", "PSCH", "B365H", "B365CH");
    const oD = ix("AvgD", "AvgCD", "PSD", "PSCD", "B365D", "B365CD");
    const oA = ix("AvgA", "AvgCA", "PSA", "PSCA", "B365A", "B365CA");
    for (const r of rows) {
      const hit = byCountry[r[iC]];
      const date = parseDate(r[iD]);
      if (!hit || !date || !r[iH] || !r[iA]) continue;
      const [code, label] = hit;
      const external_id = `fdfix_${code}_${date}_${r[iH]}_${r[iA]}`.replace(/\s+/g, "-");
      byId.set(external_id, {
        external_id, sport: "soccer", league: label, home_team: r[iH], away_team: r[iA],
        commence_time: ukToUtc(date, r[iT]), status: "scheduled",
        odds_home: toNum(r[oH]), odds_draw: toNum(r[oD]), odds_away: toNum(r[oA]), odds_updated_at: now,
      });
    }
  } else out.newError = "new_league_fixtures.csv no disponible";

  const rows = [...byId.values()].filter((r) => r.commence_time > now);
  const perLeague: Record<string, number> = {};
  for (const r of rows) perLeague[r.league] = (perLeague[r.league] ?? 0) + 1;
  out.upcoming = rows.length;
  out.perLeague = perLeague;
  out.error = rows.length ? await upsert("fixtures", rows) : null;
  return out;
}

Deno.serve(async (req: Request) => {
  let part: string | null = null;
  try { const b = await req.json(); if (b?.part) part = b.part; } catch (_e) { /* todo */ }
  const out: any = { ok: true };

  if (!part || part === "main") out.historyMain = await historyMain();
  if (!part || part === "new") out.historyNew = await historyNew();
  if (!part || part === "main" || part === "new") {
    const labels = part === "main" ? Object.values(MAIN) : part === "new" ? Object.values(NEW).map((x) => x[1]) : ALL_LABELS;
    const r = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: labels, min_games: 3 });
    out.teamsRefitted = r.error ? r.error.message : r.data;
  }
  if (!part || part === "fixtures") out.fixtures = await upcomingFixtures();

  const s = await supabase.rpc("settle_fixtures_from_history", { target_leagues: ALL_LABELS });
  out.fixturesSettled = s.error ? s.error.message : s.data;
  const rc = await supabase.rpc("recompute_soccer_model_probs");
  out.fixturesRecomputed = rc.error ? rc.error.message : rc.data;

  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
