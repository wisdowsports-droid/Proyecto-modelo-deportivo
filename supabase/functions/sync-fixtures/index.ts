import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Secrets: set via Dashboard -> Edge Functions -> Secrets
//   ODDS_API_KEY       (the-odds-api.com)
//   API_FOOTBALL_KEY   (api-football.com) -- Colombia deshabilitada: el plan
//   gratis no da acceso a la temporada actual (solo 2022-2024). Se deja el
//   codigo listo para cuando se suba de plan.
//
// Presupuesto de cuota (2026-09-23): The Odds API free tier = 500
// creditos/mes. Con markets=h2h y regions=us (1 region), cada sport_key
// cuesta 1 credito por llamada a /odds. Lista recortada a 09-23 por
// peticion explicita del usuario: se quitaron Argentina, Brasil y Liga MX
// (las 3 ligas que el usuario pidio agregar) para no tocar las ligas que
// ya estaban funcionando. Tambien se bajo regions de "us,eu" a "us" para
// no duplicar el costo. sync-fixtures corre cada 2 dias (no diario) para
// dejar presupuesto a sync-results, que si corre diario mirando solo las
// ligas con partidos pendientes en nuestra propia base.
//
// Al final de cada corrida se llama recompute_soccer_model_probs() (SQL,
// gratis) para que los partidos nuevos que crucen bien de nombre con
// team_strengths ya salgan con 1X2 del modelo sin esperar a que alguien
// haga click en el dashboard.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const API_FOOTBALL_KEY = Deno.env.get("API_FOOTBALL_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const SOCCER_WHITELIST = [
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_women",
  "soccer_usa_mls",
  "soccer_conmebol_copa_libertadores",
  "soccer_conmebol_copa_sudamericana",
];
const BASKETBALL_WHITELIST = ["basketball_nba", "basketball_wnba"];

const GROUP_TO_SPORT: Record<string, string> = {
  Soccer: "soccer",
  Tennis: "tennis",
  Basketball: "basketball",
  "American Football": "football",
  Baseball: "baseball",
};

interface FixtureRow {
  external_id: string;
  sport: string;
  league: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  odds_updated_at: string;
  odds_api_sport_key: string;
}

async function fetchOddsApiFixtures(): Promise<{ rows: FixtureRow[]; errors: string[] }> {
  const rows: FixtureRow[] = [];
  const errors: string[] = [];
  if (!ODDS_API_KEY) {
    errors.push("ODDS_API_KEY no configurada");
    return { rows, errors };
  }

  const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
  if (!sportsRes.ok) {
    errors.push(`the-odds-api /sports failed: ${sportsRes.status}`);
    return { rows, errors };
  }
  const sports: any[] = await sportsRes.json();

  const selected: any[] = [];
  for (const s of sports) {
    if (!s.active || s.key.endsWith("_winner")) continue;
    if (s.group === "Soccer" && SOCCER_WHITELIST.includes(s.key)) selected.push(s);
    else if (s.group === "Basketball" && BASKETBALL_WHITELIST.includes(s.key)) selected.push(s);
    else if (s.group === "American Football" && s.key === "americanfootball_nfl") selected.push(s);
    else if (s.group === "Baseball" && s.key === "baseball_mlb") selected.push(s);
    else if (s.group === "Tennis") selected.push(s);
  }

  for (const sportInfo of selected) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportInfo.key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
      const res = await fetch(url);
      if (!res.ok) {
        errors.push(`the-odds-api ${sportInfo.key} failed: ${res.status}`);
        continue;
      }
      const events: any[] = await res.json();
      const sportSlug = GROUP_TO_SPORT[sportInfo.group] ?? "soccer";
      for (const ev of events) {
        const book = ev.bookmakers?.[0];
        const market = book?.markets?.find((m: any) => m.key === "h2h");
        let oddsHome: number | null = null;
        let oddsDraw: number | null = null;
        let oddsAway: number | null = null;
        if (market) {
          for (const outcome of market.outcomes) {
            if (outcome.name === ev.home_team) oddsHome = outcome.price;
            else if (outcome.name === ev.away_team) oddsAway = outcome.price;
            else if (outcome.name === "Draw") oddsDraw = outcome.price;
          }
        }
        rows.push({
          external_id: `oddsapi_${ev.id}`,
          sport: sportSlug,
          league: sportInfo.title ?? sportInfo.key,
          home_team: ev.home_team,
          away_team: ev.away_team,
          commence_time: ev.commence_time,
          odds_home: oddsHome,
          odds_draw: oddsDraw,
          odds_away: oddsAway,
          odds_updated_at: new Date().toISOString(),
          odds_api_sport_key: sportInfo.key,
        });
      }
    } catch (e) {
      errors.push(`the-odds-api ${sportInfo.key} exception: ${e}`);
    }
  }

  return { rows, errors };
}

async function fetchApiFootballColombia(): Promise<{ rows: FixtureRow[]; errors: string[] }> {
  const rows: FixtureRow[] = [];
  const errors: string[] = [];
  if (!API_FOOTBALL_KEY) {
    errors.push("API_FOOTBALL_KEY no configurada");
    return { rows, errors };
  }
  const headers = { "x-apisports-key": API_FOOTBALL_KEY };

  try {
    const leaguesRes = await fetch("https://v3.football.api-sports.io/leagues?country=Colombia", { headers });
    if (!leaguesRes.ok) {
      errors.push(`api-football /leagues failed: ${leaguesRes.status}`);
      return { rows, errors };
    }
    const leaguesJson = await leaguesRes.json();
    const primeraA = (leaguesJson.response ?? []).find(
      (l: any) => /primera a/i.test(l.league?.name ?? "") && l.seasons?.some((s: any) => s.current)
    );
    if (!primeraA) {
      errors.push("no se encontro liga 'Primera A' activa para Colombia en api-football");
      return { rows, errors };
    }
    const leagueId = primeraA.league.id;
    const season = primeraA.seasons.find((s: any) => s.current).year;

    const fixturesRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}&next=10`,
      { headers }
    );
    if (!fixturesRes.ok) {
      errors.push(`api-football /fixtures failed: ${fixturesRes.status}`);
      return { rows, errors };
    }
    const fixturesJson = await fixturesRes.json();
    const bodyErrors = fixturesJson.errors;
    const hasBodyError = Array.isArray(bodyErrors) ? bodyErrors.length > 0 : bodyErrors && Object.keys(bodyErrors).length > 0;
    if (hasBodyError) {
      errors.push(`api-football /fixtures error (plan restriction esperado en free tier): ${JSON.stringify(bodyErrors)}`);
      return { rows, errors };
    }
    const fixtures = fixturesJson.response ?? [];

    for (const fx of fixtures) {
      const fixtureId = fx.fixture.id;
      let oddsHome: number | null = null;
      let oddsDraw: number | null = null;
      let oddsAway: number | null = null;
      try {
        const oddsRes = await fetch(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, { headers });
        if (oddsRes.ok) {
          const oddsJson = await oddsRes.json();
          const bookmaker = oddsJson.response?.[0]?.bookmakers?.[0];
          const matchWinner = bookmaker?.bets?.find((b: any) => b.name === "Match Winner");
          if (matchWinner) {
            for (const val of matchWinner.values) {
              const price = parseFloat(val.odd);
              if (val.value === "Home") oddsHome = price;
              else if (val.value === "Draw") oddsDraw = price;
              else if (val.value === "Away") oddsAway = price;
            }
          }
        }
      } catch (_e) {
        // sin cuotas para este partido en particular -- se guarda igual, solo sin odds
      }

      rows.push({
        external_id: `apifootball_${fixtureId}`,
        sport: "soccer",
        league: "Liga BetPlay (Colombia Primera A)",
        home_team: fx.teams.home.name,
        away_team: fx.teams.away.name,
        commence_time: fx.fixture.date,
        odds_home: oddsHome,
        odds_draw: oddsDraw,
        odds_away: oddsAway,
        odds_updated_at: new Date().toISOString(),
        odds_api_sport_key: null as unknown as string,
      });
    }
  } catch (e) {
    errors.push(`api-football exception: ${e}`);
  }

  return { rows, errors };
}

Deno.serve(async (_req: Request) => {
  const [oddsApiResult, apiFootballResult] = await Promise.all([
    fetchOddsApiFixtures(),
    fetchApiFootballColombia(),
  ]);

  const allRows = [...oddsApiResult.rows, ...apiFootballResult.rows];
  let upserted = 0;
  let upsertError: string | null = null;

  if (allRows.length > 0) {
    const { error } = await supabase.from("fixtures").upsert(allRows, { onConflict: "external_id" });
    if (error) upsertError = error.message;
    else upserted = allRows.length;
  }

  let modelRecomputed: number | null = null;
  let modelRecomputeError: string | null = null;
  try {
    const { data, error } = await supabase.rpc("recompute_soccer_model_probs");
    if (error) modelRecomputeError = error.message;
    else modelRecomputed = data as number;
  } catch (e) {
    modelRecomputeError = String(e);
  }

  const summary = {
    ok: !upsertError,
    fetched: allRows.length,
    upserted,
    upsertError,
    oddsApiRows: oddsApiResult.rows.length,
    apiFootballRows: apiFootballResult.rows.length,
    modelRecomputed,
    modelRecomputeError,
    errors: [...oddsApiResult.errors, ...apiFootballResult.errors],
  };

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
