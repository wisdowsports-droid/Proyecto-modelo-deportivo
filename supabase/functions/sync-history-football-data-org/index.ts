import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Historial de UEFA Champions League desde football-data.org (API REST,
// 10 llamadas/min y 100/dia en el plan gratis -- esta funcion gasta 1 sola
// llamada por corrida, sobra margen). Trae la temporada en curso completa
// (el endpoint regresa todos los partidos de la fase de liga en una sola
// llamada) y guarda los que ya se jugaron.
//
// Nota honesta (2026-09-23): recien empezo la fase de liga -- cada equipo
// tiene apenas 1 partido jugado. min_games=2 en el refit hace que hoy NO
// salga ningun equipo con fuerza calculada todavia -- es lo correcto, 1
// partido es puro ruido (ver README del modelo). Esto se va a ir llenando
// solo con las corridas diarias segun avancen las jornadas.

const KEY = Deno.env.get("FOOTBALL_DATA_ORG_KEY");
const LEAGUE_LABEL = "UEFA Champions League";

const TEAM_MAP: Record<string, string> = {
  "AS Roma": "AS Roma", "Arsenal FC": "Arsenal", "Aston Villa FC": "Aston Villa",
  "Borussia Dortmund": "Borussia Dortmund", "Club Atlético de Madrid": "Atlético Madrid",
  "Club Brugge KV": "Club Brugge", "Como 1907": "Como", "FC Barcelona": "Barcelona",
  "FC Bayern München": "Bayern Munich", "FC Internazionale Milano": "Inter Milan",
  "FC Porto": "Porto", "FK Bodø/Glimt": "Bodø/Glimt", "FK Shakhtar Donetsk": "Shakhtar Donetsk",
  "Fenerbahçe SK": "Fenerbahce", "Feyenoord Rotterdam": "Feyenoord", "Galatasaray SK": "Galatasaray",
  "LASK Linz": "LASK", "Lille OSC": "Lille", "Liverpool FC": "Liverpool",
  "Manchester City FC": "Manchester City", "Manchester United FC": "Manchester United",
  "PAE AEK": "AEK Athens", "PSV": "PSV Eindhoven", "Paris Saint-Germain FC": "Paris Saint Germain",
  "RB Leipzig": "RB Leipzig", "Racing Club de Lens": "RC Lens", "Real Betis Balompé": "Real Betis",
  "Real Betis Balompié": "Real Betis",
  "Real Madrid CF": "Real Madrid", "SK Slavia Praha": "Slavia Praha", "SSC Napoli": "Napoli",
  "Sabah FK": "Sabah FK", "Sporting Clube de Portugal": "Sporting Lisbon", "VfB Stuttgart": "VfB Stuttgart",
  "Viking FK": "Viking FK", "Villarreal CF": "Villarreal", "ŠK Slovan Bratislava": "Slovan Bratislava",
};

function mapTeam(name: string): string {
  return TEAM_MAP[name] ?? name;
}

Deno.serve(async (_req: Request) => {
  if (!KEY) {
    return new Response(JSON.stringify({ ok: false, error: "FOOTBALL_DATA_ORG_KEY no configurada" }), { status: 400 });
  }
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/CL/matches", {
      headers: { "X-Auth-Token": KEY },
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: `football-data.org ${res.status}` }), { status: 200 });
    }
    const body = await res.json();
    const matches: any[] = body.matches ?? [];
    const unmapped = new Set<string>();
    const rows: any[] = [];
    for (const m of matches) {
      if (m.status !== "FINISHED") continue;
      const homeScore = m.score?.fullTime?.home, awayScore = m.score?.fullTime?.away;
      if (homeScore == null || awayScore == null) continue;
      const homeName = m.homeTeam?.name, awayName = m.awayTeam?.name;
      if (!homeName || !awayName) continue;
      if (!TEAM_MAP[homeName]) unmapped.add(homeName);
      if (!TEAM_MAP[awayName]) unmapped.add(awayName);
      rows.push({
        external_id: `fdorg_cl_${m.id}`,
        sport: "soccer", league: LEAGUE_LABEL,
        match_date: m.utcDate?.slice(0, 10) ?? null,
        home_team: mapTeam(homeName), away_team: mapTeam(awayName),
        home_score: homeScore, away_score: awayScore,
        source: "football-data.org", season: String(body.filters?.season ?? ""),
      });
    }

    let upserted = 0, upsertError: string | null = null;
    if (rows.length > 0) {
      const { error } = await supabase.from("results_history").upsert(rows, { onConflict: "external_id" });
      if (error) upsertError = error.message; else upserted = rows.length;
    }

    let teamsRefitted: number | null = null, refitError: string | null = null;
    let fixturesRecomputed: number | null = null, recomputeError: string | null = null;
    if (!upsertError) {
      try {
        const { data, error } = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: [LEAGUE_LABEL], min_games: 2 });
        if (error) refitError = error.message; else teamsRefitted = data as number;
      } catch (e) { refitError = String(e); }
      try {
        const { data, error } = await supabase.rpc("recompute_soccer_model_probs");
        if (error) recomputeError = error.message; else fixturesRecomputed = data as number;
      } catch (e) { recomputeError = String(e); }
    }

    return new Response(JSON.stringify({
      ok: true, totalMatchesSeen: matches.length, finishedRows: rows.length, upserted, upsertError,
      unmappedTeams: [...unmapped], teamsRefitted, refitError, fixturesRecomputed, recomputeError,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
