import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Closes the loop that sync-fixtures leaves open: checks fixtures whose
// kickoff has passed and are still marked 'scheduled', pulls final scores
// from The Odds API's /scores endpoint (same event ids we stored as
// external_id = oddsapi_<id>, so this is a plain lookup, no team-name
// matching needed), and marks them 'finished' with the real score.
//
// Presupuesto (2026-09-23): en vez de escanear TODAS las ligas de la
// whitelist en cada corrida (desperdicia creditos en ligas sin nada
// pendiente), primero se mira la propia base (gratis, es solo SQL) para
// ver que ligas realmente tienen un fixture 'scheduled' cuyo kickoff ya
// paso -- y solo esas ligas gastan una llamada a /scores. Recortadas
// Argentina/Brasil/Liga MX el 2026-09-23 (misma whitelist que sync-fixtures).
//
// Limitation (real, not hidden): The Odds API's free tier caps /scores at
// daysFrom=3 -- a fixture whose kickoff is mas de 3 dias en el pasado
// cuando esto corre nunca se va a completar por esta via.
//
// Bug real encontrado y corregido el 2026-09-23: The Odds API a veces
// marca completed=true con score 0-0 para tenis/basquet cuando el partido
// en realidad nunca se jugo (walkover/retiro antes de empezar) -- un 0-0
// NO es un resultado valido de un partido de tenis o basquet terminado.
// Antes esto se guardaba como 'finished' con marcador inventado (0-0), lo
// cual inflaba mal las estadisticas de acierto. Ahora se detecta y se
// marca 'cancelled' en vez de inventar un resultado.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const SOCCER_WHITELIST = [
  "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga",
  "soccer_france_ligue_one", "soccer_uefa_champs_league", "soccer_uefa_champs_league_women",
  "soccer_usa_mls", "soccer_conmebol_copa_libertadores", "soccer_conmebol_copa_sudamericana",
  "soccer_uefa_nations_league", // selecciones (agregada 2026-09-28)
];
const BASKETBALL_WHITELIST = ["basketball_nba", "basketball_wnba"];

// Deportes donde 0-0 nunca es un resultado valido de un partido REALMENTE
// jugado hasta el final (futbol y beisbol si pueden terminar 0-0 de verdad,
// esos no entran aqui).
const ZERO_ZERO_IS_INVALID = new Set(["Tennis", "Basketball"]);

Deno.serve(async (_req: Request) => {
  if (!ODDS_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "ODDS_API_KEY no configurada" }), { status: 400 });
  }

  const { data: pending, error: pendingError } = await supabase
    .from("fixtures")
    .select("league")
    .eq("status", "scheduled")
    .lt("commence_time", new Date().toISOString())
    .gt("commence_time", new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());

  if (pendingError) {
    return new Response(JSON.stringify({ ok: false, error: `fixtures query failed: ${pendingError.message}` }), { status: 500 });
  }
  const pendingLeagues = new Set((pending ?? []).map((r: any) => r.league));

  if (pendingLeagues.size === 0) {
    return new Response(JSON.stringify({ ok: true, sportsChecked: 0, completedEventsSeen: 0, fixturesUpdated: 0, errors: [], note: "nada pendiente por verificar, no se gasto cuota" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
  if (!sportsRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: `sports list failed: ${sportsRes.status}` }), { status: 502 });
  }
  const sports: any[] = await sportsRes.json();

  const keysToCheck = new Map<string, string>(); // key -> group (para saber si 0-0 es invalido)
  for (const s of sports) {
    if (s.key.endsWith("_winner")) continue;
    const inWhitelist =
      (s.group === "Soccer" && SOCCER_WHITELIST.includes(s.key)) ||
      (s.group === "Basketball" && BASKETBALL_WHITELIST.includes(s.key)) ||
      (s.group === "American Football" && s.key === "americanfootball_nfl") ||
      (s.group === "Baseball" && s.key === "baseball_mlb") ||
      s.group === "Tennis";
    if (!inWhitelist) continue;
    if (pendingLeagues.has(s.title)) keysToCheck.set(s.key, s.group);
  }

  let checked = 0, updated = 0, invalidated = 0;
  const errors: string[] = [];

  for (const [key, group] of keysToCheck) {
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/${key}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`);
      if (!res.ok) { errors.push(`${key}: ${res.status}`); continue; }
      const events: any[] = await res.json();
      for (const ev of events) {
        if (!ev.completed) continue;
        checked++;
        const scores = ev.scores ?? [];
        const homeEntry = scores.find((s: any) => s.name === ev.home_team);
        const awayEntry = scores.find((s: any) => s.name === ev.away_team);
        if (!homeEntry || !awayEntry) continue;
        const homeScore = parseInt(homeEntry.score, 10);
        const awayScore = parseInt(awayEntry.score, 10);
        if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

        if (homeScore === 0 && awayScore === 0 && ZERO_ZERO_IS_INVALID.has(group)) {
          // completed=true pero 0-0 -- casi siempre walkover/retiro antes de
          // jugarse. No inventamos un resultado: se marca cancelado.
          const { data, error } = await supabase
            .from("fixtures")
            .update({ status: "cancelled" })
            .eq("external_id", `oddsapi_${ev.id}`)
            .eq("status", "scheduled")
            .select("id");
          if (error) { errors.push(`cancel ${ev.id}: ${error.message}`); continue; }
          if (data && data.length > 0) invalidated++;
          continue;
        }

        const { data, error } = await supabase
          .from("fixtures")
          .update({ status: "finished", home_score: homeScore, away_score: awayScore })
          .eq("external_id", `oddsapi_${ev.id}`)
          .eq("status", "scheduled")
          .select("id");
        if (error) { errors.push(`upsert ${ev.id}: ${error.message}`); continue; }
        if (data && data.length > 0) updated++;
      }
    } catch (e) {
      errors.push(`${key} exception: ${e}`);
    }
  }

  return new Response(JSON.stringify({ ok: true, pendingLeagues: [...pendingLeagues], sportsChecked: keysToCheck.size, completedEventsSeen: checked, fixturesUpdated: updated, invalidated, errors }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
