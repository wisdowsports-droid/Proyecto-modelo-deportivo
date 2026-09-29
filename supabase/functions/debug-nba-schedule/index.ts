import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Proper quote-aware CSV parser (handles embedded newlines/commas inside
// double-quoted fields, doubled "" as escaped quote) -- same approach that
// worked for the WNBA sportsdataverse CSV.
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
  const results: any = {};
  const t0 = Date.now();
  for (const season of [2026, 2027]) {
    const url = `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_${season}.csv`;
    const tFetchStart = Date.now();
    const res = await fetch(url);
    if (!res.ok) { results[season] = { ok: false, status: res.status }; continue; }
    const text = await res.text();
    const tFetchEnd = Date.now();

    const header = [...parseCsvRows(text.slice(0, text.indexOf("\n") + 1))][0];
    const idx = (name: string) => header.indexOf(name);
    const iDate = idx("game_date"), iHome = idx("home_display_name"), iAway = idx("away_display_name"),
          iHomeScore = idx("home_score"), iAwayScore = idx("away_score"),
          iCompleted = idx("status_type_completed"), iSeasonType = idx("season_type"), iGameId = idx("game_id");

    let rowCount = 0, completedCount = 0, regSeasonCompleted = 0;
    let sample: any = null;
    for (const row of parseCsvRows(text)) {
      rowCount++;
      if (rowCount === 1) continue; // header
      const completed = row[iCompleted] === "true";
      if (completed) completedCount++;
      if (completed && row[iSeasonType] === "2") {
        regSeasonCompleted++;
        if (!sample) {
          sample = { date: row[iDate], home: row[iHome], away: row[iAway], homeScore: row[iHomeScore], awayScore: row[iAwayScore], gameId: row[iGameId] };
        }
      }
    }
    const tParseEnd = Date.now();
    results[season] = {
      ok: true,
      bytes: text.length,
      dataRows: rowCount - 1,
      completedCount,
      regSeasonCompleted,
      sample,
      fetchMs: tFetchEnd - tFetchStart,
      parseMs: tParseEnd - tFetchEnd,
    };
  }
  results.totalMs = Date.now() - t0;
  return new Response(JSON.stringify(results, null, 2), { headers: { "Content-Type": "application/json" } });
});
