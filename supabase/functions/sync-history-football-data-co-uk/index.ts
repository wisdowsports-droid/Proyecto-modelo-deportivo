import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Historial + estadisticas de partido (corners, tarjetas, tiros, faltas)
// de football-data.co.uk (CSV publico, sin llave, sin limite de tasa
// documentado -- se actualiza ~2 veces por semana segun el sitio, no
// gasta NADA de la cuota de The Odds API porque es un dominio totalmente
// aparte). Trae la temporada anterior COMPLETA (2025-26, sirve de base
// estable, incluye la primera temporada en primera division de los
// ascendidos) + la temporada en curso (2026-27, la mas fresca) para las
// 5 ligas grandes europeas. Reemplazo, para estas 5 ligas, de la fuente
// vieja (api-football, atascada en 2022-2024) -- y de paso habilita
// cordners/tarjetas que antes no teniamos para nada.
//
// Al final recalcula fuerzas de equipo Y las probabilidades 1X2 de todos
// los partidos programados, para que quede listo sin esperar un click.

const LEAGUES: Record<string, string> = {
  E0: "EPL",
  SP1: "La Liga - Spain",
  I1: "Serie A - Italy",
  D1: "Bundesliga - Germany",
  F1: "Ligue 1 - France",
};
const SEASONS = ["2526", "2627"];

const TEAM_MAP: Record<string, string> = {
  "Arsenal": "Arsenal", "Aston Villa": "Aston Villa", "Bournemouth": "Bournemouth",
  "Brentford": "Brentford", "Brighton": "Brighton and Hove Albion", "Burnley": "Burnley",
  "Chelsea": "Chelsea", "Crystal Palace": "Crystal Palace", "Everton": "Everton",
  "Fulham": "Fulham", "Leeds": "Leeds United", "Liverpool": "Liverpool",
  "Man City": "Manchester City", "Man United": "Manchester United", "Newcastle": "Newcastle United",
  "Nott'm Forest": "Nottingham Forest", "Sunderland": "Sunderland", "Tottenham": "Tottenham Hotspur",
  "West Ham": "West Ham United", "Wolves": "Wolves", "Ipswich": "Ipswich Town",
  "Southampton": "Southampton", "Leicester": "Leicester", "Coventry": "Coventry City", "Hull": "Hull City",
  "Alaves": "Alavés", "Ath Bilbao": "Athletic Bilbao", "Ath Madrid": "Atlético Madrid",
  "Barcelona": "Barcelona", "Betis": "Real Betis", "Celta": "Celta Vigo", "Elche": "Elche CF",
  "Espanol": "Espanyol", "Getafe": "Getafe", "Girona": "Girona", "Levante": "Levante",
  "Mallorca": "Mallorca", "Osasuna": "Osasuna", "Oviedo": "Real Oviedo", "Real Madrid": "Real Madrid",
  "Sevilla": "Sevilla", "Sociedad": "Real Sociedad", "Valencia": "Valencia", "Vallecano": "Rayo Vallecano",
  "Villarreal": "Villarreal", "Las Palmas": "Las Palmas", "Valladolid": "Valladolid", "Leganes": "Leganes",
  "Santander": "Real Racing Club de Santander", "La Coruna": "Deportivo La Coruña", "Malaga": "Málaga",
  "Atalanta": "Atalanta", "Bologna": "Bologna", "Cagliari": "Cagliari", "Como": "Como",
  "Cremonese": "Cremonese", "Fiorentina": "Fiorentina", "Genoa": "Genoa", "Inter": "Inter",
  "Juventus": "Juventus", "Lazio": "Lazio", "Lecce": "Lecce", "Milan": "AC Milan",
  "Napoli": "Napoli", "Parma": "Parma", "Pisa": "Pisa", "Roma": "AS Roma", "Sassuolo": "Sassuolo",
  "Torino": "Torino", "Udinese": "Udinese", "Verona": "Hellas Verona", "Empoli": "Empoli",
  "Monza": "Monza", "Venezia": "Venezia", "Frosinone": "Frosinone",
  "Augsburg": "FC Augsburg", "Bayern Munich": "Bayern Munich", "Dortmund": "Borussia Dortmund",
  "Ein Frankfurt": "Eintracht Frankfurt", "FC Koln": "1. FC Köln", "Freiburg": "SC Freiburg",
  "Hamburg": "Hamburger SV", "Heidenheim": "1. FC Heidenheim", "Hoffenheim": "TSG Hoffenheim",
  "Leverkusen": "Bayer Leverkusen", "M'gladbach": "Borussia Mönchengladbach", "Mainz": "FSV Mainz 05",
  "RB Leipzig": "RB Leipzig", "St Pauli": "FC St. Pauli", "Stuttgart": "VfB Stuttgart",
  "Union Berlin": "Union Berlin", "Werder Bremen": "Werder Bremen", "Wolfsburg": "VfL Wolfsburg",
  "Bochum": "VfL Bochum", "Holstein Kiel": "Holstein Kiel", "Elversberg": "SV Elversberg",
  "Paderborn": "SC Paderborn", "Schalke 04": "FC Schalke 04",
  "Angers": "Angers", "Auxerre": "Auxerre", "Brest": "Brest", "Le Havre": "Le Havre",
  "Lens": "Lens", "Lille": "Lille", "Lorient": "Lorient", "Lyon": "Lyon", "Marseille": "Marseille",
  "Metz": "Metz", "Monaco": "Monaco", "Nantes": "Nantes", "Nice": "Nice", "Paris FC": "Paris FC",
  "Paris SG": "Paris Saint Germain", "Rennes": "Rennes", "Strasbourg": "Strasbourg",
  "Toulouse": "Toulouse", "Reims": "Reims", "St Etienne": "Saint Etienne", "Le Mans": "Le Mans FC",
  "Troyes": "Troyes",
};

function mapTeam(name: string): string {
  return TEAM_MAP[name] ?? name;
}

function parseCsvLine(line: string): string[] {
  return line.split(",");
}

function parseDate(d: string): string | null {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = (parseInt(yy, 10) < 50 ? "20" : "19") + yy;
  return `${yy}-${mm}-${dd}`;
}

function toInt(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const perLeague: Record<string, any> = {};
  let totalRows = 0;
  const leagueLabels = Object.values(LEAGUES);

  for (const [code, label] of Object.entries(LEAGUES)) {
    let leagueRows = 0;
    const unmapped = new Set<string>();
    for (const season of SEASONS) {
      try {
        const url = `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length < 2) continue;
        const header = parseCsvLine(lines[0]);
        const idx = (name: string) => header.indexOf(name);
        const iDate = idx("Date"), iHome = idx("HomeTeam"), iAway = idx("AwayTeam");
        const iFTHG = idx("FTHG"), iFTAG = idx("FTAG");
        const iHS = idx("HS"), iAS = idx("AS"), iHST = idx("HST"), iAST = idx("AST");
        const iHC = idx("HC"), iAC = idx("AC"), iHY = idx("HY"), iAY = idx("AY");
        const iHR = idx("HR"), iAR = idx("AR"), iHF = idx("HF"), iAF = idx("AF");

        const rows: any[] = [];
        for (let i = 1; i < lines.length; i++) {
          const r = parseCsvLine(lines[i]);
          if (r.length < 5 || !r[iHome] || !r[iAway]) continue;
          const dateIso = parseDate(r[iDate]);
          if (!dateIso) continue;
          const homeScore = toInt(r[iFTHG]), awayScore = toInt(r[iFTAG]);
          if (homeScore == null || awayScore == null) continue;
          const homeTeam = mapTeam(r[iHome]), awayTeam = mapTeam(r[iAway]);
          if (!TEAM_MAP[r[iHome]]) unmapped.add(r[iHome]);
          if (!TEAM_MAP[r[iAway]]) unmapped.add(r[iAway]);
          rows.push({
            external_id: `fdcouk_${code}_${season}_${dateIso}_${r[iHome]}_${r[iAway]}`.replace(/\s+/g, "-"),
            sport: "soccer", league: label, match_date: dateIso,
            home_team: homeTeam, away_team: awayTeam,
            home_score: homeScore, away_score: awayScore,
            source: "football-data.co.uk", season,
            home_shots: toInt(r[iHS]), away_shots: toInt(r[iAS]),
            home_shots_on_target: toInt(r[iHST]), away_shots_on_target: toInt(r[iAST]),
            home_corners: toInt(r[iHC]), away_corners: toInt(r[iAC]),
            home_yellow: toInt(r[iHY]), away_yellow: toInt(r[iAY]),
            home_red: toInt(r[iHR]), away_red: toInt(r[iAR]),
            home_fouls: toInt(r[iHF]), away_fouls: toInt(r[iAF]),
          });
        }
        if (rows.length > 0) {
          const { error } = await supabase.from("results_history").upsert(rows, { onConflict: "external_id" });
          if (error) { perLeague[`${label}_${season}_error`] = error.message; continue; }
          leagueRows += rows.length;
          totalRows += rows.length;
        }
      } catch (e) {
        perLeague[`${label}_${season}_exception`] = String(e);
      }
    }
    perLeague[label] = { rows: leagueRows, unmappedTeams: [...unmapped] };
  }

  let teamsRefitted: number | null = null, refitError: string | null = null;
  let fixturesRecomputed: number | null = null, recomputeError: string | null = null;
  try {
    const { data, error } = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: leagueLabels, min_games: 3 });
    if (error) refitError = error.message; else teamsRefitted = data as number;
  } catch (e) { refitError = String(e); }
  try {
    const { data, error } = await supabase.rpc("recompute_soccer_model_probs");
    if (error) recomputeError = error.message; else fixturesRecomputed = data as number;
  } catch (e) { recomputeError = String(e); }

  return new Response(JSON.stringify({ ok: true, totalRows, perLeague, teamsRefitted, refitError, fixturesRecomputed, recomputeError }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
