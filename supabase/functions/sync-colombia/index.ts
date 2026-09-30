import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Liga colombiana (Liga BetPlay / Primera A) gratis desde los datos publicos
// de ESPN (liga "col.1"). The Odds API no cubre Colombia y el plan gratis de
// api-football no da la temporada actual.
//   - historial: resultados de los ultimos ~2 anos (source 'espn')
//   - calendario: proximos 14 dias, con cuotas 1X2 de DraftKings que ESPN
//     publica en el mismo scoreboard (gratis). Pinnacle cerro su API publica
//     en julio de 2025 y The Odds API no cubre Colombia.
//   - calificacion: los partidos ya jugados se cierran por el id de ESPN
// Al final recalcula fuerzas de equipo y pronosticos.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const LABEL = "Liga BetPlay (Colombia Primera A)";
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/scoreboard";
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };
const HISTORY_DAYS = 730;
const AHEAD_DAYS = 14;

// ESPN acepta dates=YYYYMM (mes completo); los rangos YYYYMMDD-YYYYMMDD dan 400.
const ym = (t: number) => new Date(t).toISOString().slice(0, 7).replace("-", "");
function monthsBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(from); d.setUTCDate(1);
  while (d.getTime() <= to) { out.push(ym(d.getTime())); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

async function events(month: string): Promise<any[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?dates=${month}`, { headers: HEADERS });
      if (r.ok) { const j = await r.json(); return j.events ?? []; }
    } catch (_e) { /* reintento */ }
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
  }
  return null;
}

// Cuota americana ("+185", "-200", 160) -> decimal (2.85, 1.50, 2.60)
function amToDec(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace("+", ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return +(n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n)).toFixed(3);
}

function parse(e: any) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
  const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
  if (!home || !away) return null;
  return {
    id: e.id as string, date: e.date as string,
    home: home.team?.displayName as string, away: away.team?.displayName as string,
    hs: parseInt(home.score, 10), as: parseInt(away.score, 10),
    completed: !!e.status?.type?.completed,
    postponed: /POSTPONED|CANCELED|SUSPENDED/i.test(e.status?.type?.name ?? ""),
    odds: (() => {
      const o = comp?.odds?.[0];
      const ml = o?.moneyline;
      const h = amToDec(ml?.home?.close?.odds ?? ml?.home?.open?.odds);
      const a = amToDec(ml?.away?.close?.odds ?? ml?.away?.open?.odds);
      const d = amToDec(o?.drawOdds?.moneyLine);
      return h && a && d ? { h, d, a } : null;
    })(),
  };
}

Deno.serve(async (req: Request) => {
  let history = true;
  try { const b = await req.json(); if (b?.history === false) history = false; } catch (_e) { /* defaults */ }
  const now = Date.now();
  const out: any = { ok: true };

  // 1) historial mes a mes; tambien guarda los proximos partidos que salgan
  const hist = new Map<string, any>();
  const finished: any[] = [];
  const seen = new Map<string, any>();
  let failedChunks = 0;
  const start = now - (history ? HISTORY_DAYS : 20) * 86400000;
  for (const month of monthsBetween(start, now + AHEAD_DAYS * 86400000)) {
    const ev = await events(month);
    if (!ev) { failedChunks++; continue; }
    for (const e of ev) {
      const q = parse(e);
      if (q) seen.set(q.id, q);
    }
    for (const e of ev) {
      const p = parse(e);
      if (!p) continue;
      if (p.completed && !Number.isNaN(p.hs) && !Number.isNaN(p.as)) {
        finished.push(p);
        hist.set(`espn_col1_${p.id}`, {
          external_id: `espn_col1_${p.id}`, sport: "soccer", league: LABEL, match_date: p.date.slice(0, 10),
          home_team: p.home, away_team: p.away, home_score: p.hs, away_score: p.as, source: "espn", season: null,
        });
      }
    }
  }
  const histRows = [...hist.values()];
  for (let i = 0; i < histRows.length; i += 500) {
    const { error } = await supabase.from("results_history").upsert(histRows.slice(i, i + 500), { onConflict: "external_id" });
    if (error) { out.historyError = error.message; break; }
  }
  out.history = { rows: histRows.length, failedChunks };

  // 2) proximos partidos
  const fx = [...seen.values()].filter((p) => !p.completed && !p.postponed && Date.parse(p.date) > now && Date.parse(p.date) < now + AHEAD_DAYS * 86400000).map((p: any) => ({
    external_id: `espn_col1_${p.id}`, sport: "soccer", league: LABEL, home_team: p.home, away_team: p.away,
    commence_time: new Date(p.date).toISOString(), status: "scheduled", odds_updated_at: new Date().toISOString(),
    odds_home: p.odds?.h ?? null, odds_draw: p.odds?.d ?? null, odds_away: p.odds?.a ?? null,
  }));
  if (fx.length) {
    const { error } = await supabase.from("fixtures").upsert(fx, { onConflict: "external_id" });
    if (error) out.fixturesError = error.message;
  }
  out.upcoming = fx.length;
  out.withOdds = fx.filter((r) => r.odds_home).length;

  // 3) calificar partidos ya jugados (por id de ESPN)
  let settled = 0;
  const recent = finished.filter((p) => Date.parse(p.date) > now - 20 * 86400000);
  for (const p of recent) {
    const { data } = await supabase.from("fixtures")
      .update({ status: "finished", home_score: p.hs, away_score: p.as })
      .eq("external_id", `espn_col1_${p.id}`).eq("status", "scheduled").select("id");
    settled += data?.length ?? 0;
  }
  out.settled = settled;

  // 4) fuerzas y pronosticos
  if (history) {
    await supabase.from("team_strengths").delete().eq("league", LABEL);
    const r = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: [LABEL], min_games: 3 });
    out.teamsRefitted = r.error ? r.error.message : r.data;
  }
  const rc = await supabase.rpc("recompute_soccer_model_probs");
  out.fixturesRecomputed = rc.error ? rc.error.message : rc.data;

  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
