import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Ligas de futbol gratis desde los datos publicos de ESPN (resultados,
// calendario y cuotas 1X2 de DraftKings cuando existen). Generaliza lo que
// se hizo para Colombia. No gasta creditos de The Odds API.
//
// body: { league: "uru.1", backfill?: true }
//   - backfill: trae ~2 anos de historial (se hace una vez por liga)
//   - normal: trae los ultimos ~40 dias + proximos 14 (rapido, diario)
// En ambos casos: guarda historial, calendario con cuotas, califica los
// partidos jugados por id de ESPN, recalcula fuerzas y pronosticos.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// codigo ESPN -> etiqueta de liga en nuestra base
const LEAGUES: Record<string, string> = {
  "col.1": "Liga BetPlay (Colombia Primera A)",
  "uru.1": "Primera División - Uruguay",
  "per.1": "Liga 1 - Peru",
  "chi.1": "Primera División - Chile",
  "ecu.1": "LigaPro - Ecuador",
  "par.1": "Primera División - Paraguay",
};
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };
const BACKFILL_DAYS = 730;
const RECENT_DAYS = 40;
const AHEAD_DAYS = 14;

// ESPN acepta dates=YYYYMM (mes completo); los rangos YYYYMMDD-YYYYMMDD dan 400.
const ym = (t: number) => new Date(t).toISOString().slice(0, 7).replace("-", "");
function monthsBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(from); d.setUTCDate(1);
  while (d.getTime() <= to) { out.push(ym(d.getTime())); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

async function events(code: string, month: string): Promise<any[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${month}`, { headers: HEADERS });
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
  const o = comp?.odds?.[0];
  const ml = o?.moneyline;
  const h = amToDec(ml?.home?.close?.odds ?? ml?.home?.open?.odds);
  const a = amToDec(ml?.away?.close?.odds ?? ml?.away?.open?.odds);
  const d = amToDec(o?.drawOdds?.moneyLine);
  return {
    id: e.id as string, date: e.date as string,
    home: home.team?.displayName as string, away: away.team?.displayName as string,
    hs: parseInt(home.score, 10), as: parseInt(away.score, 10),
    completed: !!e.status?.type?.completed,
    postponed: /POSTPONED|CANCELED|SUSPENDED/i.test(e.status?.type?.name ?? ""),
    odds: h && a && d ? { h, d, a } : null,
  };
}

Deno.serve(async (req: Request) => {
  let code = "", backfill = false;
  try { const b = await req.json(); code = b?.league ?? ""; backfill = !!b?.backfill; } catch (_e) { /* sin body */ }
  const label = LEAGUES[code];
  if (!label) return new Response(JSON.stringify({ ok: false, error: `liga desconocida '${code}'`, validas: Object.keys(LEAGUES) }), { status: 400 });
  const slug = code.replace(".", "");
  const now = Date.now();
  const out: any = { ok: true, league: label };

  const hist = new Map<string, any>();
  const seen = new Map<string, any>();
  let failedMonths = 0;
  const start = now - (backfill ? BACKFILL_DAYS : RECENT_DAYS) * 86400000;
  for (const month of monthsBetween(start, now + AHEAD_DAYS * 86400000)) {
    const ev = await events(code, month);
    if (!ev) { failedMonths++; continue; }
    for (const e of ev) {
      const p = parse(e);
      if (!p) continue;
      seen.set(p.id, p);
      if (p.completed && !Number.isNaN(p.hs) && !Number.isNaN(p.as)) {
        hist.set(`espn_${slug}_${p.id}`, {
          external_id: `espn_${slug}_${p.id}`, sport: "soccer", league: label, match_date: p.date.slice(0, 10),
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
  out.history = { rows: histRows.length, failedMonths };

  // proximos partidos (con cuotas si DraftKings ya las publico)
  const fx = [...seen.values()].filter((p) => !p.completed && !p.postponed && Date.parse(p.date) > now && Date.parse(p.date) < now + AHEAD_DAYS * 86400000).map((p: any) => ({
    external_id: `espn_${slug}_${p.id}`, sport: "soccer", league: label, home_team: p.home, away_team: p.away,
    commence_time: new Date(p.date).toISOString(), status: "scheduled", odds_updated_at: new Date().toISOString(),
    odds_home: p.odds?.h ?? null, odds_draw: p.odds?.d ?? null, odds_away: p.odds?.a ?? null,
  }));
  if (fx.length) {
    const { error } = await supabase.from("fixtures").upsert(fx, { onConflict: "external_id" });
    if (error) out.fixturesError = error.message;
  }
  out.upcoming = fx.length;
  out.withOdds = fx.filter((r) => r.odds_home).length;

  // calificar partidos jugados en los ultimos 20 dias (por id de ESPN)
  let settled = 0;
  for (const p of seen.values()) {
    if (!p.completed || Number.isNaN(p.hs) || Date.parse(p.date) < now - 20 * 86400000) continue;
    const { data } = await supabase.from("fixtures")
      .update({ status: "finished", home_score: p.hs, away_score: p.as })
      .eq("external_id", `espn_${slug}_${p.id}`).eq("status", "scheduled").select("id");
    settled += data?.length ?? 0;
  }
  out.settled = settled;

  // fuerzas (desde todo el historial guardado) y pronosticos
  if (backfill) await supabase.from("team_strengths").delete().eq("league", label);
  const r = await supabase.rpc("refit_team_strengths_from_history", { target_leagues: [label], min_games: 3 });
  out.teamsRefitted = r.error ? r.error.message : r.data;
  const rc = await supabase.rpc("recompute_soccer_model_probs");
  out.fixturesRecomputed = rc.error ? rc.error.message : rc.data;

  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
