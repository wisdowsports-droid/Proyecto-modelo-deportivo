import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const API_FOOTBALL_KEY = Deno.env.get("API_FOOTBALL_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

type Target =
  | { kind: "country"; country: string; namePattern: RegExp; label: string }
  | { kind: "search"; query: string; namePattern: RegExp; label: string };

const TARGETS: Target[] = [
  { kind: "country", country: "Colombia", namePattern: /primera a/i, label: "Liga BetPlay (Colombia Primera A)" },
  { kind: "country", country: "England", namePattern: /premier league/i, label: "EPL" },
  { kind: "country", country: "Spain", namePattern: /la liga/i, label: "La Liga - Spain" },
  { kind: "country", country: "Brazil", namePattern: /^serie a$/i, label: "Brazil Série A" },
  { kind: "country", country: "Argentina", namePattern: /liga profesional|primera divisi/i, label: "Primera División - Argentina" },
  { kind: "country", country: "Germany", namePattern: /bundesliga$/i, label: "Bundesliga - Germany" },
  { kind: "country", country: "France", namePattern: /ligue 1/i, label: "Ligue 1 - France" },
  { kind: "country", country: "Italy", namePattern: /serie a/i, label: "Serie A - Italy" },
  { kind: "country", country: "USA", namePattern: /major league soccer|^mls$/i, label: "MLS" },
  { kind: "country", country: "Mexico", namePattern: /liga ?mx/i, label: "Liga MX" },
  { kind: "search", query: "UEFA Champions League", namePattern: /^uefa champions league$/i, label: "UEFA Champions League" },
  { kind: "search", query: "UEFA Champions League Women", namePattern: /champions league women/i, label: "UEFA Champions League Women" },
  { kind: "search", query: "Libertadores", namePattern: /^conmebol libertadores$/i, label: "Copa Libertadores" },
  { kind: "search", query: "Sudamericana", namePattern: /^conmebol sudamericana$/i, label: "Copa Sudamericana" },
];
const SEASON = 2024;

async function resolveLeague(target: Target, headers: Record<string,string>) {
  const url = target.kind === "country"
    ? `https://v3.football.api-sports.io/leagues?country=${encodeURIComponent(target.country)}`
    : `https://v3.football.api-sports.io/leagues?search=${encodeURIComponent(target.query)}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  const list = json.response ?? [];
  return list.find((l: any) => target.namePattern.test(l.league?.name ?? ""));
}

Deno.serve(async (req: Request) => {
  if (!API_FOOTBALL_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "API_FOOTBALL_KEY no configurada" }), { status: 400 });
  }
  const headers = { "x-apisports-key": API_FOOTBALL_KEY };

  let only: string[] | null = null;
  try {
    const body = await req.json();
    if (Array.isArray(body?.labels)) only = body.labels;
  } catch (_e) { /* run everything */ }

  const targets = only ? TARGETS.filter((t) => only!.includes(t.label)) : TARGETS;
  const perLeague: Record<string, any> = {};
  let totalRows = 0;

  for (const target of targets) {
    try {
      const match = await resolveLeague(target, headers);
      if (!match) {
        perLeague[target.label] = { error: "liga no encontrada" };
        continue;
      }
      const leagueId = match.league.id;

      const fixturesRes = await fetch(
        `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${SEASON}&status=FT`,
        { headers }
      );
      const fixturesJson = await fixturesRes.json();
      const bodyErrors = fixturesJson.errors;
      const hasBodyError = Array.isArray(bodyErrors) ? bodyErrors.length > 0 : bodyErrors && Object.keys(bodyErrors).length > 0;
      if (hasBodyError) {
        perLeague[target.label] = { leagueId, error: bodyErrors };
        continue;
      }

      const fixtures = fixturesJson.response ?? [];
      const rows = fixtures
        .filter((fx: any) => fx.goals?.home !== null && fx.goals?.away !== null)
        .map((fx: any) => ({
          external_id: `apifootball_hist_${fx.fixture.id}`,
          sport: "soccer",
          league: target.label,
          match_date: fx.fixture.date,
          home_team: fx.teams.home.name,
          away_team: fx.teams.away.name,
          home_score: fx.goals.home,
          away_score: fx.goals.away,
          source: "api-football",
        }));

      if (rows.length > 0) {
        const { error } = await supabase.from("results_history").upsert(rows, { onConflict: "external_id" });
        if (error) {
          perLeague[target.label] = { leagueId, fetched: rows.length, upsertError: error.message };
          continue;
        }
      }

      perLeague[target.label] = { leagueId, season: SEASON, fetched: rows.length };
      totalRows += rows.length;
    } catch (e) {
      perLeague[target.label] = { error: String(e) };
    }
  }

  return new Response(JSON.stringify({ ok: true, totalRows, perLeague }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
