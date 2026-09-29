import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Historial actualizado de Argentina, Brasil, Mexico y MLS desde
// football-data.co.uk ("new leagues": un CSV por pais con todas las
// temporadas, sin llave, no gasta creditos de The Odds API). Reemplaza como
// fuente del modelo a api-football, que estaba atascada en 2024.
//
// Ademas califica los partidos de esas ligas que ya se jugaron y siguen como
// 'scheduled' en fixtures (sync-results no las consulta para ahorrar
// creditos): los cruza con el resultado real por fecha y nombres.
// Al final recalcula fuerzas de equipo y pronosticos.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// codigo del archivo -> nombre de la liga como lo usa The Odds API (fixtures)
const LEAGUES: Record<string, string> = {
  ARG: "Primera División - Argentina",
  BRA: "Brazil Série A",
  MEX: "Liga MX",
  USA: "MLS",
};
const SINCE_DAYS = 800;

// Nombres de football-data.co.uk -> nombres de The Odds API (los que usan
// fixtures y el pronosticador). Sin esto, "Ind. Rivadavia" terminaba
// emparejado con "Independiente" (otro club) por coincidencia parcial.
const TEAM_MAP: Record<string, string> = {
  // Brasil
  "Athletico-PR": "Atletico Paranaense", "Atletico-MG": "Atletico Mineiro", "Botafogo RJ": "Botafogo",
  "Bragantino": "Bragantino-SP", "Chapecoense-SC": "Chapecoense", "Flamengo RJ": "Flamengo",
  "Gremio": "Grêmio", "Vasco": "Vasco da Gama",
  // MLS
  "Atlanta Utd": "Atlanta United FC", "Charlotte": "Charlotte FC", "Columbus Crew": "Columbus Crew SC",
  "DC United": "D.C. United", "Inter Miami": "Inter Miami CF", "Los Angeles Galaxy": "LA Galaxy",
  "Minnesota United": "Minnesota United FC", "New York City": "New York City FC", "Orlando City": "Orlando City SC",
  "Seattle Sounders": "Seattle Sounders FC", "St. Louis City": "St. Louis City SC", "Vancouver Whitecaps": "Vancouver Whitecaps FC",
  // Argentina
  "Aldosivi": "Aldosivi Mar del Plata", "Argentinos Jrs": "Argentinos Juniors", "Atl. Tucuman": "Atlético Tucuman",
  "Belgrano": "Belgrano de Cordoba", "Central Cordoba": "Central Córdoba", "Dep. Riestra": "Deportivo Riestra",
  "Estudiantes L.P.": "Estudiantes", "Estudiantes Rio Cuarto": "Estudiantes de Río Cuarto", "Gimnasia L.P.": "Gimnasia La Plata",
  "Huracan": "Atlético Huracán", "Ind. Rivadavia": "Independiente Rivadavia", "Instituto": "Instituto de Córdoba",
  "Sarmiento Junin": "Sarmiento de Junin", "Talleres Cordoba": "Talleres", "Tigre": "CA Tigre BA",
  "Union de Santa Fe": "Union Santa Fe", "Velez Sarsfield": "Velez Sarsfield BA",
  // Mexico
  "Atl. San Luis": "Atlético San Luis", "Atlante": "Atlante FC", "Club America": "América", "Club Leon": "León",
  "Club Tijuana": "Tijuana", "Guadalajara Chivas": "Guadalajara", "Juarez": "FC Juárez", "Queretaro": "Querétaro",
  "Tigres UANL": "Tigres", "UNAM Pumas": "Pumas",
};
const mapTeam = (n: string) => TEAM_MAP[n.trim()] ?? n.trim();

function parseDate(d: string): string | null {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = "20" + yy;
  return `${yy}-${mm}-${dd}`;
}

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { const res = await fetch(url); if (!res.ok) return null; return await res.text(); }
    catch (_e) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
  }
  return null;
}

Deno.serve(async (_req: Request) => {
  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString().slice(0, 10);
  const perLeague: Record<string, any> = {};

  for (const [code, label] of Object.entries(LEAGUES)) {
    const text = await fetchText(`https://www.football-data.co.uk/new/${code}.csv`);
    if (!text) { perLeague[label] = { error: "descarga fallida" }; continue; }
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",").map((h) => h.trim());
    const ix = (n: string) => header.indexOf(n);
    const iS = ix("Season"), iD = ix("Date"), iH = ix("Home"), iA = ix("Away"), iHG = ix("HG"), iAG = ix("AG");
    const byId = new Map<string, any>(); // el CSV de MLS trae filas repetidas
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const date = parseDate(c[iD]);
      if (!date || date < since) continue;
      const hg = parseInt(c[iHG], 10), ag = parseInt(c[iAG], 10);
      if (Number.isNaN(hg) || Number.isNaN(ag) || !c[iH] || !c[iA]) continue;
      const external_id = `fdnew_${code}_${date}_${c[iH]}_${c[iA]}`.replace(/\s+/g, "-");
      byId.set(external_id, {
        external_id, sport: "soccer", league: label, match_date: date,
        home_team: mapTeam(c[iH]), away_team: mapTeam(c[iA]), home_score: hg, away_score: ag,
        source: "football-data.co.uk", season: (c[iS] ?? "").trim() || null,
      });
    }
    const rows = [...byId.values()];
    let upserted = 0, error: string | null = null;
    for (let i = 0; i < rows.length && !error; i += 500) {
      const r = await supabase.from("results_history").upsert(rows.slice(i, i + 500), { onConflict: "external_id" });
      if (r.error) error = r.error.message; else upserted += Math.min(500, rows.length - i);
    }
    perLeague[label] = { upserted, error, latest: rows.reduce((m, r) => (r.match_date > m ? r.match_date : m), "") };
  }

  const labels = Object.values(LEAGUES);
  const out: any = { ok: true, perLeague };
  // Se recalculan desde cero: asi no quedan equipos descendidos ni nombres viejos.
  await supabase.from("team_strengths").delete().in("league", labels);
  const r1 = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: labels, min_games: 3 });
  out.teamsRefitted = r1.error ? r1.error.message : r1.data;
  const r2 = await supabase.rpc("settle_fixtures_from_history", { target_leagues: labels });
  out.fixturesSettled = r2.error ? r2.error.message : r2.data;
  const r3 = await supabase.rpc("recompute_soccer_model_probs");
  out.fixturesRecomputed = r3.error ? r3.error.message : r3.data;

  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
