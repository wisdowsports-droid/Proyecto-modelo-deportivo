import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// One-time backfill: nflverse's public games.csv on GitHub (no key, no
// rate limit worth worrying about) -- ESPN's own API blocks Edge Function
// IPs with a 403, so this is the real source. Feeds results_history.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const TEAM_NAMES: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams", LAC: "Los Angeles Chargers", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
  OAK: "Las Vegas Raiders", SD: "Los Angeles Chargers", STL: "Los Angeles Rams",
};

// Minimal CSV line parser handling quoted fields with embedded commas.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

Deno.serve(async (req: Request) => {
  let seasons = [2025];
  try {
    const body = await req.json();
    if (Array.isArray(body?.seasons)) seasons = body.seasons;
  } catch (_e) { /* defaults */ }

  const res = await fetch("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv");
  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, error: `nflverse fetch failed: ${res.status}` }), { status: 502 });
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iSeason = idx("season"), iType = idx("game_type"), iDay = idx("gameday"),
        iAway = idx("away_team"), iAwayScore = idx("away_score"),
        iHome = idx("home_team"), iHomeScore = idx("home_score"), iId = idx("game_id");

  const rows: any[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    const season = parseInt(cols[iSeason], 10);
    if (!seasons.includes(season)) continue;
    if (cols[iType] !== "REG") continue;
    const awayScore = cols[iAwayScore], homeScore = cols[iHomeScore];
    if (!awayScore || !homeScore) continue; // not yet played
    const awayAbbr = cols[iAway], homeAbbr = cols[iHome];
    rows.push({
      external_id: `nfl_${cols[iId]}`,
      sport: "football",
      league: "NFL",
      match_date: cols[iDay],
      home_team: TEAM_NAMES[homeAbbr] ?? homeAbbr,
      away_team: TEAM_NAMES[awayAbbr] ?? awayAbbr,
      home_score: parseInt(homeScore, 10),
      away_score: parseInt(awayScore, 10),
      source: "nflverse",
    });
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

  return new Response(JSON.stringify({ ok: true, totalGames: rows.length, inserted, seasons }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
