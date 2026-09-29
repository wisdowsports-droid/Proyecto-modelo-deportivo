import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (req: Request) => {
  let startDate = "2025-03-01";
  let endDate = "2025-11-15";
  try {
    const body = await req.json();
    if (body?.startDate) startDate = body.startDate;
    if (body?.endDate) endDate = body.endDate;
  } catch (_e) { /* defaults */ }

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R`;
  const res = await fetch(url);
  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, error: `statsapi failed: ${res.status}` }), { status: 502 });
  }
  const json = await res.json();
  const byId = new Map<string, any>();
  for (const day of json.dates ?? []) {
    for (const g of day.games ?? []) {
      if (g.status?.detailedState !== "Final") continue;
      const home = g.teams?.home, away = g.teams?.away;
      if (home?.score == null || away?.score == null) continue;
      const external_id = `mlb_${g.gamePk}`;
      byId.set(external_id, {
        external_id,
        sport: "baseball",
        league: "MLB",
        match_date: g.gameDate,
        home_team: home.team.name,
        away_team: away.team.name,
        home_score: home.score,
        away_score: away.score,
        source: "statsapi.mlb.com",
      });
    }
  }
  const rows = Array.from(byId.values());

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

  return new Response(JSON.stringify({ ok: true, totalGames: rows.length, inserted, startDate, endDate }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
