import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Historial de selecciones nacionales para el modelo de futbol.
// Fuente: martj42/international_results (CSV publico en GitHub, sin llave):
// todos los partidos internacionales masculinos desde 1872, incluidos
// amistosos, eliminatorias, Nations League y torneos continentales.
//
// Se guardan los ultimos ~3 anos en results_history con
// league = "UEFA Nations League" (la etiqueta con la que The Odds API nombra
// esos partidos) para que el modelo v2 calcule fuerzas de ataque/defensa por
// seleccion. Se usan partidos de TODAS las confederaciones y torneos: una
// seleccion juega pocos partidos al ano, y los amistosos y eliminatorias
// tambien dicen cuanto vale. Al final recalcula fuerzas y pronosticos.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const LEAGUE_LABEL = "UEFA Nations League";
const SOURCE = "international-results";
const URL = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";

// Nombres del CSV -> nombres de The Odds API cuando difieren.
const TEAM_MAP: Record<string, string> = {
  "Czechia": "Czech Republic",
  "Türkiye": "Turkey",
  "Ireland": "Republic of Ireland",
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

Deno.serve(async (req: Request) => {
  let sinceDays = 1100;
  try { const b = await req.json(); if (b?.sinceDays) sinceDays = b.sinceDays; } catch (_e) { /* defaults */ }
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);

  const res = await fetch(URL);
  if (!res.ok) return new Response(JSON.stringify({ ok: false, error: `github ${res.status}` }), { status: 502 });
  const lines = (await res.text()).split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]);
  const ix = (n: string) => header.indexOf(n);
  const iDate = ix("date"), iH = ix("home_team"), iA = ix("away_team"), iHS = ix("home_score"), iAS = ix("away_score"), iT = ix("tournament");

  const byId = new Map<string, any>();
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c[iDate] < since) continue;
    const hs = parseInt(c[iHS], 10), as = parseInt(c[iAS], 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue; // partido aun no jugado
    const home = TEAM_MAP[c[iH]] ?? c[iH], away = TEAM_MAP[c[iA]] ?? c[iA];
    const external_id = `intl_${c[iDate]}_${c[iH]}_${c[iA]}`.replace(/\s+/g, "-");
    byId.set(external_id, {
      external_id, sport: "soccer", league: LEAGUE_LABEL, match_date: c[iDate],
      home_team: home, away_team: away, home_score: hs, away_score: as,
      source: SOURCE, season: null,
    });
  }
  const rows = [...byId.values()];

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from("results_history").upsert(rows.slice(i, i + 500), { onConflict: "external_id" });
    if (error) return new Response(JSON.stringify({ ok: false, upserted, error: error.message }), { status: 500 });
    upserted += Math.min(500, rows.length - i);
  }

  let teamsRefitted: number | null = null, fixturesRecomputed: number | null = null;
  const errors: string[] = [];
  const r1 = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: [LEAGUE_LABEL], min_games: 3 });
  if (r1.error) errors.push(r1.error.message); else teamsRefitted = r1.data as number;
  const r2 = await supabase.rpc("recompute_soccer_model_probs");
  if (r2.error) errors.push(r2.error.message); else fixturesRecomputed = r2.data as number;

  return new Response(JSON.stringify({ ok: errors.length === 0, since, upserted, teamsRefitted, fixturesRecomputed, errors }, null, 1), {
    headers: { "Content-Type": "application/json" },
  });
});
