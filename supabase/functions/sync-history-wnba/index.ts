import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Historial WNBA desde wehoop/sportsdataverse (CSV publico en releases de
// GitHub, sin llave, sin limite documentado). Guarda los partidos ya
// jugados de la temporada 2026 en results_history -- el ajuste Elo en si
// se hace aparte (motor de margin-Elo de picks_engine, igual que NBA/NFL/MLB).

const LEAGUE_LABEL = "WNBA";

const TEAM_MAP: Record<string, string> = {
  "Aces": "Las Vegas Aces", "Dream": "Atlanta Dream", "Fever": "Indiana Fever",
  "Fire": "Portland Fire", "Liberty": "New York Liberty", "Lynx": "Minnesota Lynx",
  "Mercury": "Phoenix Mercury", "Mystics": "Washington Mystics", "Sky": "Chicago Sky",
  "Sparks": "Los Angeles Sparks", "Storm": "Seattle Storm", "Sun": "Connecticut Sun",
  "Tempo": "Toronto Tempo", "Valkyries": "Golden State Valkyries", "Wings": "Dallas Wings",
};
// Equipos de exhibicion (All-Star) -- no son franquicias reales, se excluyen.
const SKIP_TEAMS = new Set(["TEAM COOP", "TEAM SPOON"]);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n') { row.push(field); field = ""; rows.push(row); row = []; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const url = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_wnba_schedules/wnba_schedule_2026.csv";
  try {
    const res = await fetch(url);
    if (!res.ok) return new Response(JSON.stringify({ ok: false, error: `status ${res.status}` }), { status: 200 });
    const text = await res.text();
    const rows = parseCsv(text);
    const header = rows[0];
    const idx = (n: string) => header.indexOf(n);
    const iId = idx("game_id"), iCompleted = idx("status_type_completed");
    const iHome = idx("home_name"), iAway = idx("away_name");
    const iHomeScore = idx("home_score"), iAwayScore = idx("away_score"), iDate = idx("game_date");

    const unmapped = new Set<string>();
    const dbRows: any[] = [];
    for (const r of rows.slice(1)) {
      if (r[iCompleted] !== "true") continue;
      const homeRaw = r[iHome], awayRaw = r[iAway];
      if (SKIP_TEAMS.has(homeRaw) || SKIP_TEAMS.has(awayRaw)) continue;
      const homeTeam = TEAM_MAP[homeRaw], awayTeam = TEAM_MAP[awayRaw];
      if (!homeTeam) unmapped.add(homeRaw);
      if (!awayTeam) unmapped.add(awayRaw);
      if (!homeTeam || !awayTeam) continue;
      const homeScore = parseInt(r[iHomeScore], 10), awayScore = parseInt(r[iAwayScore], 10);
      if (Number.isNaN(homeScore) || Number.isNaN(awayScore) || homeScore === awayScore) continue;
      dbRows.push({
        external_id: `wehoop_${r[iId]}`, sport: "basketball", league: LEAGUE_LABEL,
        match_date: r[iDate], home_team: homeTeam, away_team: awayTeam,
        home_score: homeScore, away_score: awayScore, source: "wehoop", season: "2026",
      });
    }

    let upserted = 0, upsertError: string | null = null;
    if (dbRows.length > 0) {
      const { error } = await supabase.from("results_history").upsert(dbRows, { onConflict: "external_id" });
      if (error) upsertError = error.message; else upserted = dbRows.length;
    }

    return new Response(JSON.stringify({ ok: true, totalRows: rows.length - 1, upserted, upsertError, unmappedTeams: [...unmapped] }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
