import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// NBA results, current + prior season, from sportsdataverse-data (GitHub
// Releases, tag espn_nba_schedules), the ESPN-derived CSV that hoopR's
// load_nba_schedule() downloads. Same mechanism, same CSV structure, as our
// WNBA source (sportsdataverse/wehoop) -- no auth, no rate limit. This
// REPLACES the old sync-history-nba (which pulled a static, dead
// 2010-2024 GitHub dataset with no path to current data). Feeds
// results_history for picks_engine's Elo model.
//
// The CSV is much heavier than the WNBA one -- it embeds large
// highlight/play-by-play metadata blobs (Python-repr'd dicts/arrays) inside
// a few quoted fields -- but it's still standard RFC4180 quoting (double
// quotes, "" escape), so the same quote-aware parser handles it fine.
// Verified via a diagnostic run: ~9MB for a full season, parses in <1s.
//
// season_type === "2" ("regular season") in this feed also includes the
// All-Star Weekend mini-games, played by exhibition rosters ("Team
// Stripes"/"Team Stars"/"World", not real franchises) -- excluded below the
// same way the WNBA source's "TEAM COOP"/"TEAM SPOON" placeholders were.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const EXHIBITION_TEAMS = new Set(["Team Stripes", "Team Stars", "World", "Team Chuck", "Team Shaq", "Team Kenny", "Team Candace"]);

function* parseCsvRows(text: string): Generator<string[]> {
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") yield row;
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); yield row; }
}

Deno.serve(async (req: Request) => {
  let seasons = [2026, 2027]; // sportsdataverse convention: season = ending year (2026 = 2025-26 season)
  try {
    const body = await req.json();
    if (Array.isArray(body?.seasons)) seasons = body.seasons;
  } catch (_e) { /* defaults */ }

  const rows: any[] = [];
  const fetchErrors: any[] = [];

  for (const season of seasons) {
    const url = `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_${season}.csv`;
    const res = await fetch(url);
    if (!res.ok) { fetchErrors.push({ season, status: res.status }); continue; }
    const text = await res.text();

    let header: string[] | null = null;
    let idx: Record<string, number> = {};
    for (const row of parseCsvRows(text)) {
      if (!header) {
        header = row;
        const at = (name: string) => header!.indexOf(name);
        idx = {
          date: at("game_date"), home: at("home_display_name"), away: at("away_display_name"),
          homeScore: at("home_score"), awayScore: at("away_score"),
          completed: at("status_type_completed"), seasonType: at("season_type"), gameId: at("game_id"),
        };
        continue;
      }
      if (row[idx.completed] !== "true") continue;
      if (row[idx.seasonType] !== "2") continue; // regular season only
      const home = row[idx.home], away = row[idx.away];
      if (EXHIBITION_TEAMS.has(home) || EXHIBITION_TEAMS.has(away)) continue; // All-Star Weekend exhibitions
      const homeScore = parseInt(row[idx.homeScore], 10);
      const awayScore = parseInt(row[idx.awayScore], 10);
      if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;
      rows.push({
        external_id: `espn_nba_${row[idx.gameId]}`,
        sport: "basketball",
        league: "NBA",
        match_date: row[idx.date],
        home_team: home,
        away_team: away,
        home_score: homeScore,
        away_score: awayScore,
        source: "espn-nba-schedule",
      });
    }
  }

  const knownTeams = new Set([
    "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls",
    "Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors",
    "Houston Rockets","Indiana Pacers","LA Clippers","Los Angeles Clippers","Los Angeles Lakers",
    "Memphis Grizzlies","Miami Heat","Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans",
    "New York Knicks","Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns",
    "Portland Trail Blazers","Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
  ]);
  const unmapped = new Set<string>();
  for (const r of rows) {
    if (!knownTeams.has(r.home_team)) unmapped.add(r.home_team);
    if (!knownTeams.has(r.away_team)) unmapped.add(r.away_team);
  }

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("results_history").upsert(chunk, { onConflict: "external_id" });
    if (error) {
      return new Response(JSON.stringify({ ok: false, insertedSoFar: inserted, error: error.message }), { status: 500 });
    }
    inserted += chunk.length;
  }

  return new Response(JSON.stringify({
    ok: true, totalGames: rows.length, inserted, seasons, fetchErrors,
    unmappedTeams: [...unmapped],
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
