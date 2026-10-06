import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Radar de valor (privado, plan gratis de The Odds API).
// Cada hora revisa SOLO las ligas que tienen un partido empezando en las
// proximas 3 horas (cerca del cierre, donde la prueba historica mostro valor).
// Cuota justa = Pinnacle sin margen. Guarda en value_radar cada seleccion donde
// la mejor cuota de otra casa supera la justa en >= 2 % (cuota <= 5).
// Cuidado de creditos: regions=eu, markets=h2h,totals (2 creditos por liga),
// cada liga max. 1 vez cada 5 h, tope de 10 creditos al dia, y no corre si
// quedan menos de 150 creditos (para no dejar sin cuotas al resto del sistema).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const KEY = Deno.env.get("ODDS_API_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "Content-Type": "application/json" } });

const MIN_EDGE = 0.02, MAX_ODDS = 5, DAILY_CAP = 10, MIN_REMAINING = 150, COST = 2;
const fairOf = (prices: number[]) => { const s = prices.reduce((a, p) => a + 1 / p, 0); return prices.map((p) => p * s); };

Deno.serve(async (req: Request) => {
  if (!KEY) return json({ ok: false, error: "ODDS_API_KEY no configurada" }, 400);
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const now = Date.now();

  // presupuesto
  const { data: q } = await supabase.from("api_quota").select("remaining").eq("api", "the-odds-api").maybeSingle();
  if (q && q.remaining < MIN_REMAINING) return json({ ok: true, skipped: `quedan ${q.remaining} creditos (< ${MIN_REMAINING})` });
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { data: today } = await supabase.from("radar_scans").select("credits, sport_key, scanned_at").gte("scanned_at", new Date(now - 24 * 3600000).toISOString());
  const usedToday = (today ?? []).filter((r: any) => Date.parse(r.scanned_at) >= dayStart.getTime()).reduce((a: number, r: any) => a + (r.credits ?? 0), 0);
  const recent = new Set((today ?? []).filter((r: any) => Date.parse(r.scanned_at) > now - 5 * 3600000).map((r: any) => r.sport_key));

  // ligas con partidos en las proximas 3 h
  const { data: fx } = await supabase.from("fixtures").select("odds_api_sport_key")
    .eq("sport", "soccer").eq("status", "scheduled").not("odds_api_sport_key", "is", null)
    .gte("commence_time", new Date(now + 20 * 60000).toISOString())
    .lte("commence_time", new Date(now + 3 * 3600000).toISOString());
  let sports = [...new Set((fx ?? []).map((r: any) => r.odds_api_sport_key as string))].filter((s) => !recent.has(s));
  if (body.sports) sports = body.sports; // prueba manual
  const out: any = { ok: true, usedToday, scanned: [] as any[] };

  for (const sp of sports) {
    if (usedToday + out.scanned.length * COST + COST > DAILY_CAP && !body.sports) { out.stopped = "tope diario de creditos"; break; }
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`);
    const remaining = parseInt(res.headers.get("x-requests-remaining") ?? "", 10);
    if (Number.isFinite(remaining)) await supabase.from("api_quota").upsert({ api: "the-odds-api", remaining, updated_at: new Date().toISOString() });
    if (!res.ok) { out.scanned.push({ sp, error: res.status }); continue; }
    const events: any[] = await res.json();
    let withPin = 0, found = 0;
    for (const ev of events) {
      if (Date.parse(ev.commence_time) < now) continue; // ya empezo
      const books = ev.bookmakers ?? [];
      const pin = books.find((b: any) => b.key === "pinnacle");
      if (!pin) continue;
      withPin++;
      const { data: f } = await supabase.from("fixtures").select("id, league").eq("external_id", `oddsapi_${ev.id}`).maybeSingle();
      for (const mk of ["h2h", "totals"]) {
        const pm = pin.markets?.find((m: any) => m.key === mk);
        if (!pm) continue;
        const pOut = mk === "totals" ? pm.outcomes.filter((o: any) => o.point === 2.5) : pm.outcomes;
        if ((mk === "totals" && pOut.length !== 2) || (mk === "h2h" && pOut.length !== 3)) continue;
        const fair = fairOf(pOut.map((o: any) => o.price));
        for (let i = 0; i < pOut.length; i++) {
          const o = pOut[i];
          let best = { price: 0, book: "" };
          for (const b of books) {
            if (b.key === "pinnacle" || b.key.startsWith("betfair_ex")) continue; // sin exchanges (cobran comision)
            const m = b.markets?.find((x: any) => x.key === mk);
            const oo = m?.outcomes?.find((x: any) => x.name === o.name && (mk !== "totals" || x.point === 2.5));
            if (oo && oo.price > best.price) best = { price: oo.price, book: b.title };
          }
          const edge = best.price / fair[i] - 1;
          if (!best.price || edge < MIN_EDGE || best.price > MAX_ODDS) continue;
          found++;
          await supabase.from("value_radar").upsert({
            fixture_id: f?.id ?? null, event_id: ev.id, sport_key: sp, league: f?.league ?? sp,
            home_team: ev.home_team, away_team: ev.away_team, commence_time: ev.commence_time,
            market: mk === "h2h" ? "1X2" : "Goles 2.5", selection: o.name,
            fair_odds: +fair[i].toFixed(3), best_odds: best.price, best_book: best.book, edge: +edge.toFixed(4),
            scanned_at: new Date().toISOString(),
          }, { onConflict: "event_id,market,selection" });
        }
      }
    }
    await supabase.from("radar_scans").insert({ sport_key: sp, events: events.length, with_pinnacle: withPin, found, credits: COST, remaining: Number.isFinite(remaining) ? remaining : null });
    out.scanned.push({ sp, events: events.length, withPin, found, remaining });
  }
  return json(out);
});
