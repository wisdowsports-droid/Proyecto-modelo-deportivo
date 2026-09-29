import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Trae mercados adicionales para UN partido puntual (goles/totales, ambos
// anotan, doble oportunidad, empate anula, marcador exacto, corners,
// tarjetas, goleador) Y calcula, con nuestro PROPIO modelo (Poisson de
// goles/corners/tarjetas), cual seleccion es mas probable y si hay valor
// real contra la cuota de mercado. Se dispara solo cuando el usuario hace
// click/expande un partido -- nunca en batch.
//
// Corners y tarjetas usan el MISMO enfoque multiplicativo que goles
// (fuerza de equipo x promedio de liga -> Poisson), pero ojo: es una
// simplificacion real, no oculta. Las tarjetas en particular suelen tener
// mas varianza de la que un Poisson puro predice (dependen del arbitro,
// de si el partido se pone tenso, etc.) -- se trata como una primera
// version util, no como el modelo definitivo.
//
// Cada mercado evaluado guarda EXACTAMENTE el pronostico que se le muestra
// al usuario en el panel (mismo criterio que pickRow en el dashboard: si
// alguno de los dos lados tiene valor se guarda ese, si no se guarda el
// mas probable segun el modelo) -- no solo los que despejan el umbral de
// valor, para poder medir despues si acertamos incluso cuando no habia
// valor. `is_value` en la fila distingue cual fue cual, y `fixture_id`
// deja el settlement automatico (ver settle_picks_for_fixture) sin
// depender de comparar el texto del evento.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CACHE_TTL_MINUTES = 20;
const NEAR_KICKOFF_DAYS = 4;
const VALUE_THRESHOLD = 0.03;
const KELLY_MULTIPLIER = 0.25;

const SOCCER_CORE = ["h2h", "totals", "btts", "double_chance", "draw_no_bet", "totals_h1", "btts_h1", "correct_score"];
const SOCCER_NEAR_EXTRA = ["alternate_totals_corners", "alternate_totals_cards", "player_goal_scorer_anytime"];
const OTHER_SPORT_MARKETS: Record<string, string[]> = {
  basketball: ["h2h", "spreads", "totals", "alternate_totals"],
  football: ["h2h", "spreads", "totals", "alternate_totals"],
  baseball: ["h2h", "spreads", "totals", "alternate_totals"],
  tennis: ["h2h", "totals", "spreads"],
};

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function scorelineMatrix(lamHome: number, lamAway: number, maxGoals = 20): number[][] {
  const m: number[][] = [];
  for (let i = 0; i <= maxGoals; i++) {
    const pi = poissonPmf(i, lamHome);
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j++) row.push(pi * poissonPmf(j, lamAway));
    m.push(row);
  }
  return m;
}

function matrixTotal(m: number[][]): number {
  return m.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
}

function matchProbs(m: number[][]) {
  const total = matrixTotal(m);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      if (i > j) home += m[i][j];
      else if (i === j) draw += m[i][j];
      else away += m[i][j];
    }
  }
  return { home: home / total, draw: draw / total, away: away / total };
}

function overUnder(m: number[][], line: number) {
  const total = matrixTotal(m);
  let over = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (i + j > line) over += m[i][j];
  return { over: over / total, under: 1 - over / total };
}

function bttsProbs(m: number[][]) {
  const total = matrixTotal(m);
  let yes = 0;
  for (let i = 1; i < m.length; i++) for (let j = 1; j < m[i].length; j++) yes += m[i][j];
  return { yes: yes / total, no: 1 - yes / total };
}

function devigShin(odds: number[]): number[] {
  const p = odds.map((o) => 1 / o);
  const total = p.reduce((a, b) => a + b, 0);
  if (total <= 1.0) return p.map((pi) => pi / total);

  const piOfZ = (z: number) => p.map((pi) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / total) - z) / (2 * (1 - z)));
  const fOfZ = (z: number) => piOfZ(z).reduce((a, b) => a + b, 0) - 1;

  let lo = 0, hi = 1 - 1e-9;
  const fLo = fOfZ(lo), fHi = fOfZ(hi);
  if (fLo * fHi > 0) return p.map((pi) => pi / total);

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fOfZ(lo) * fOfZ(mid) <= 0) hi = mid; else lo = mid;
  }
  const fair = piOfZ((lo + hi) / 2);
  const s = fair.reduce((a, b) => a + b, 0);
  return fair.map((v) => v / s);
}

function devigDoubleChance(odds: number[]): number[] {
  const p = odds.map((o) => 1 / o);
  const overround = p.reduce((a, b) => a + b, 0) / 2;
  return p.map((pi) => pi / overround);
}

function kellyFraction(modelProb: number, decimalOdds: number): number {
  const b = decimalOdds - 1.0;
  const q = 1.0 - modelProb;
  return Math.max((b * modelProb - q) / b, 0);
}

function evaluateWith(fairProbs: number[], marketOdds: number[], modelProb: number, pickedIndex: number) {
  const fairMarketProb = fairProbs[pickedIndex];
  const decimalOdds = marketOdds[pickedIndex];
  const edge = modelProb - fairMarketProb;
  const kf = kellyFraction(modelProb, decimalOdds);
  return {
    model_prob: modelProb,
    fair_market_prob: fairMarketProb,
    decimal_odds: decimalOdds,
    edge,
    kelly_stake: kf * KELLY_MULTIPLIER,
    is_value: edge >= VALUE_THRESHOLD,
  };
}

function evaluate(modelProb: number, marketOdds: number[], pickedIndex: number) {
  return evaluateWith(devigShin(marketOdds), marketOdds, modelProb, pickedIndex);
}

function avgPriceByOutcome(entries: any[]): Record<string, { avg: number; n: number }> {
  const groups: Record<string, number[]> = {};
  for (const e of entries) {
    for (const o of e.outcomes ?? []) {
      const key = o.name + (o.point != null ? " " + o.point : "");
      (groups[key] ??= []).push(+o.price);
    }
  }
  const out: Record<string, { avg: number; n: number }> = {};
  for (const k of Object.keys(groups)) out[k] = { avg: groups[k].reduce((a, b) => a + b, 0) / groups[k].length, n: groups[k].length };
  return out;
}

function mostCommonLine(entries: any[]): number | null {
  const counts: Record<string, number> = {};
  for (const e of entries) for (const o of e.outcomes ?? []) if (o.point != null) counts[o.point] = (counts[o.point] ?? 0) + 1;
  const keys = Object.keys(counts);
  if (!keys.length) return null;
  keys.sort((a, b) => counts[b] - counts[a]);
  return parseFloat(keys[0]);
}

// Un mercado Over/Under generico (corners, tarjetas, goles) contra el modelo.
function evaluateOverUnderMarket(matrix: number[][], entries: any[]): any | null {
  const line = mostCommonLine(entries);
  if (line == null) return null;
  const ou = overUnder(matrix, line);
  const agg = avgPriceByOutcome(entries);
  const overKey = `Over ${line}`, underKey = `Under ${line}`;
  if (!agg[overKey] || !agg[underKey]) return null;
  const odds2 = [agg[overKey].avg, agg[underKey].avg];
  return {
    line, most_likely: ou.over >= ou.under ? "Over" : "Under",
    over: evaluate(ou.over, odds2, 0), under: evaluate(ou.under, odds2, 1),
  };
}

Deno.serve(async (req: Request) => {
  if (!ODDS_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "ODDS_API_KEY no configurada" }), { status: 400 });
  }

  let fixtureId: number | null = null;
  try {
    const body = await req.json();
    fixtureId = Number(body.fixture_id);
  } catch (_e) { /* sin body valido */ }
  if (!fixtureId || Number.isNaN(fixtureId)) {
    return new Response(JSON.stringify({ ok: false, error: "fixture_id requerido en el body" }), { status: 400 });
  }

  const { data: fx, error: fxError } = await supabase
    .from("fixtures")
    .select("id, external_id, sport, league, home_team, away_team, commence_time, odds_api_sport_key")
    .eq("id", fixtureId)
    .single();

  if (fxError || !fx) {
    return new Response(JSON.stringify({ ok: false, error: `fixture ${fixtureId} no encontrado: ${fxError?.message ?? ""}` }), { status: 404 });
  }

  const { data: cached } = await supabase.from("event_markets").select("fetched_at").eq("fixture_id", fixtureId).maybeSingle();
  if (cached && (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_TTL_MINUTES * 60 * 1000) {
    return new Response(JSON.stringify({ ok: true, cached: true, note: "servido desde cache, no se gasto cuota" }), { status: 200 });
  }

  if (!fx.external_id?.startsWith("oddsapi_") || !fx.odds_api_sport_key) {
    const row = { fixture_id: fixtureId, markets: {}, bookmakers_seen: 0, status: "unsupported", error: "este partido no viene de The Odds API -- no hay mercados adicionales disponibles", fetched_at: new Date().toISOString() };
    await supabase.from("event_markets").upsert(row, { onConflict: "fixture_id" });
    return new Response(JSON.stringify({ ok: true, ...row }), { status: 200 });
  }

  const eventId = fx.external_id.replace("oddsapi_", "");
  const daysToKickoff = (new Date(fx.commence_time).getTime() - Date.now()) / (24 * 3600 * 1000);

  let marketList: string[];
  if (fx.sport === "soccer") {
    marketList = daysToKickoff <= NEAR_KICKOFF_DAYS ? [...SOCCER_CORE, ...SOCCER_NEAR_EXTRA] : SOCCER_CORE;
  } else {
    marketList = OTHER_SPORT_MARKETS[fx.sport] ?? ["h2h", "totals"];
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${fx.odds_api_sport_key}/events/${eventId}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=${marketList.join(",")}&oddsFormat=decimal`;
    const res = await fetch(url);
    if (!res.ok) {
      const row = { fixture_id: fixtureId, markets: {}, bookmakers_seen: 0, status: "error", error: `the-odds-api ${res.status}`, fetched_at: new Date().toISOString() };
      await supabase.from("event_markets").upsert(row, { onConflict: "fixture_id" });
      return new Response(JSON.stringify({ ok: false, ...row }), { status: 200 });
    }
    const body = await res.json();

    const byMarket: Record<string, any[]> = {};
    for (const bm of body?.bookmakers ?? []) {
      for (const m of bm.markets ?? []) {
        (byMarket[m.key] ??= []).push({ bookmaker: bm.title, last_update: m.last_update, outcomes: m.outcomes });
      }
    }

    const recommendations: Record<string, any> = {};
    let modelUsed = false;
    if (fx.sport === "soccer") {
      const [{ data: baseline }, { data: homeMatchName }, { data: awayMatchName }] = await Promise.all([
        supabase.from("league_goal_baselines").select("avg_home_goals, avg_away_goals, avg_home_corners, avg_away_corners, avg_home_cards, avg_away_cards").eq("league", fx.league).maybeSingle(),
        supabase.rpc("match_team_strength", { p_league: fx.league, p_team_name: fx.home_team }),
        supabase.rpc("match_team_strength", { p_league: fx.league, p_team_name: fx.away_team }),
      ]);
      let home: any = null, away: any = null;
      if (homeMatchName && awayMatchName) {
        const { data: strengths } = await supabase
          .from("team_strengths").select("team, attack, defense, corner_attack, corner_defense, card_attack, card_defense")
          .eq("league", fx.league).in("team", [homeMatchName, awayMatchName]);
        home = strengths?.find((s: any) => s.team === homeMatchName);
        away = strengths?.find((s: any) => s.team === awayMatchName);
      }
      if (baseline && home && away) {
        modelUsed = true;
        const lamHome = +baseline.avg_home_goals * +home.attack * +away.defense;
        const lamAway = +baseline.avg_away_goals * +away.attack * +home.defense;
        const matrix = scorelineMatrix(lamHome, lamAway, 10);
        const mp = matchProbs(matrix);

        if (byMarket.totals?.length) recommendations.totals = evaluateOverUnderMarket(matrix, byMarket.totals);
        if (byMarket.btts?.length) {
          const bt = bttsProbs(matrix);
          const agg = avgPriceByOutcome(byMarket.btts);
          if (agg["Yes"] && agg["No"]) {
            const odds2 = [agg["Yes"].avg, agg["No"].avg];
            recommendations.btts = {
              most_likely: bt.yes >= bt.no ? "Sí" : "No",
              yes: evaluate(bt.yes, odds2, 0), no: evaluate(bt.no, odds2, 1),
            };
          }
        }
        if (byMarket.double_chance?.length) {
          const agg = avgPriceByOutcome(byMarket.double_chance);
          const k1x = `${fx.home_team} or Draw`, kx2 = `${fx.away_team} or Draw`;
          const k12a = `${fx.home_team} or ${fx.away_team}`, k12b = `${fx.away_team} or ${fx.home_team}`;
          const k12 = agg[k12a] ? k12a : (agg[k12b] ? k12b : null);
          if (agg[k1x] && agg[kx2] && k12) {
            const modelProbs = [mp.home + mp.draw, mp.draw + mp.away, mp.home + mp.away];
            const odds3 = [agg[k1x].avg, agg[kx2].avg, agg[k12].avg];
            const fairDc = devigDoubleChance(odds3);
            const evals = [0, 1, 2].map((i) => evaluateWith(fairDc, odds3, modelProbs[i], i));
            const labels = ["1X (local o empate)", "X2 (empate o visitante)", "12 (sin empate)"];
            const bestIdx = modelProbs.indexOf(Math.max(...modelProbs));
            recommendations.double_chance = { most_likely: labels[bestIdx], options: evals.map((e, i) => ({ label: labels[i], ...e })) };
          }
        }

        // Corners y tarjetas: mismo enfoque, solo si tenemos fuerzas de
        // corners/tarjetas para AMBOS equipos (ligas con football-data.co.uk).
        // Nunca se asume un numero por defecto -- si falta el dato, se omite.
        if (baseline.avg_home_corners != null && home.corner_attack != null && away.corner_attack != null && byMarket.alternate_totals_corners?.length) {
          const lamHomeC = +baseline.avg_home_corners * +home.corner_attack * +away.corner_defense;
          const lamAwayC = +baseline.avg_away_corners * +away.corner_attack * +home.corner_defense;
          const cornerMatrix = scorelineMatrix(lamHomeC, lamAwayC, 20);
          recommendations.alternate_totals_corners = evaluateOverUnderMarket(cornerMatrix, byMarket.alternate_totals_corners);
        }
        if (baseline.avg_home_cards != null && home.card_attack != null && away.card_attack != null && byMarket.alternate_totals_cards?.length) {
          const lamHomeK = +baseline.avg_home_cards * +home.card_attack * +away.card_defense;
          const lamAwayK = +baseline.avg_away_cards * +away.card_attack * +home.card_defense;
          const cardMatrix = scorelineMatrix(lamHomeK, lamAwayK, 12);
          recommendations.alternate_totals_cards = evaluateOverUnderMarket(cardMatrix, byMarket.alternate_totals_cards);
        }

        recommendations.__model = { lam_home: lamHome, lam_away: lamAway, home_win: mp.home, draw: mp.draw, away_win: mp.away, matched_home: home.team, matched_away: away.team };
      }
    }

    const row = {
      fixture_id: fixtureId,
      markets: byMarket,
      recommendations,
      model_used: modelUsed,
      bookmakers_seen: body?.bookmakers?.length ?? 0,
      status: "ok",
      error: null,
      fetched_at: new Date().toISOString(),
    };
    const { error: upsertError } = await supabase.from("event_markets").upsert(row, { onConflict: "fixture_id" });

    // Guarda EXACTAMENTE el pronostico que se muestra en el panel (pickRow
    // en el dashboard): el lado con valor si lo hay, si no el mas probable
    // segun el modelo -- un solo renglon por mercado, no ambos lados.
    const forecasts: any[] = [];
    const pushForecast = (marketLabel: string, selLabel: string, ev: any) => {
      forecasts.push({
        sport: "soccer", league: fx.league, event: `${fx.home_team} vs ${fx.away_team}`,
        event_date: fx.commence_time, market: marketLabel, selection: selLabel,
        decimal_odds: ev.decimal_odds, model_prob: ev.model_prob, fair_market_prob: ev.fair_market_prob,
        edge: ev.edge, kelly_stake: ev.kelly_stake, is_value: ev.is_value, status: "pending",
        fixture_id: fixtureId,
      });
    };
    if (recommendations.totals) {
      const t = recommendations.totals;
      const best = t.over.is_value ? t.over : (t.under.is_value ? t.under : (t.most_likely === "Over" ? t.over : t.under));
      pushForecast(`Goles totales ${t.line}`, (best === t.over ? "Over " : "Under ") + t.line, best);
    }
    if (recommendations.btts) {
      const b = recommendations.btts;
      const best = b.yes.is_value ? b.yes : (b.no.is_value ? b.no : (b.most_likely === "Sí" ? b.yes : b.no));
      pushForecast("Ambos anotan", best === b.yes ? "Sí" : "No", best);
    }
    if (recommendations.double_chance) {
      const dc = recommendations.double_chance;
      const best = dc.options.find((o: any) => o.is_value) || dc.options.reduce((a: any, c: any) => (c.model_prob > a.model_prob ? c : a));
      pushForecast("Doble oportunidad", best.label, best);
    }
    if (recommendations.alternate_totals_corners) {
      const c = recommendations.alternate_totals_corners;
      const best = c.over.is_value ? c.over : (c.under.is_value ? c.under : (c.most_likely === "Over" ? c.over : c.under));
      pushForecast(`Córners totales ${c.line}`, (best === c.over ? "Over " : "Under ") + c.line, best);
    }
    if (recommendations.alternate_totals_cards) {
      const k = recommendations.alternate_totals_cards;
      const best = k.over.is_value ? k.over : (k.under.is_value ? k.under : (k.most_likely === "Over" ? k.over : k.under));
      pushForecast(`Tarjetas totales ${k.line}`, (best === k.over ? "Over " : "Under ") + k.line, best);
    }
    if (forecasts.length) {
      await supabase.from("picks").upsert(forecasts, { onConflict: "event,market,selection" });
      // El partido pudo haber terminado entre corridas anteriores y esta --
      // si ya hay marcador, liquida de una vez en lugar de dejarlo pendiente
      // hasta el proximo cambio en `fixtures`.
      await supabase.rpc("settle_picks_for_fixture", { p_fixture_id: fixtureId });
    }

    return new Response(JSON.stringify({ ok: !upsertError, upsertError, marketsFound: Object.keys(byMarket), modelUsed, recommendations, forecastsSaved: forecasts.length, bookmakersSeen: row.bookmakers_seen, creditsUsed: res.headers.get("x-requests-last") }), { status: 200 });
  } catch (e) {
    const row = { fixture_id: fixtureId, markets: {}, bookmakers_seen: 0, status: "error", error: String(e), fetched_at: new Date().toISOString() };
    await supabase.from("event_markets").upsert(row, { onConflict: "fixture_id" });
    return new Response(JSON.stringify({ ok: false, ...row }), { status: 200 });
  }
});
