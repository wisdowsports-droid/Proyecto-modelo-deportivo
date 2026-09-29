import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
Deno.serve(async (_req: Request) => {
  if (!ODDS_API_KEY) return new Response(JSON.stringify({ error: "no key" }), { status: 500 });
  const res = await fetch(`https://api.the-odds-api.com/v4/sports/tennis_wta_singapore_open/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`);
  const remaining = res.headers.get("x-requests-remaining");
  const body = await res.json();
  const target = (Array.isArray(body) ? body : []).find((e: any) => e.id === 'd970c335660e8c64598b7f88e378dc76');
  return new Response(JSON.stringify({ remaining, status: res.status, found: !!target, target, allIds: (Array.isArray(body)?body:[]).map((e:any)=>({id:e.id, home:e.home_team, away:e.away_team, completed:e.completed, scores:e.scores})) }, null, 2), { headers: { "Content-Type": "application/json" } });
});
