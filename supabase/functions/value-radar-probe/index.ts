import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Prueba del "Radar de valor": trae cuotas de The Odds API (regiones eu,uk),
// calcula la cuota justa de Pinnacle (sin margen) y lista las apuestas donde
// alguna casa paga mas que esa cuota justa. Solo lectura, no guarda nada.
// body: { sports: ["soccer_epl", ...], minEdge?: 0.02, maxOdds?: 5 }
// Costo: (#mercados=2) x (#regiones=2) = 4 creditos por liga.

const KEY = Deno.env.get("ODDS_API_KEY");

function fair(prices: number[]) {
  const s = prices.reduce((a, p) => a + 1 / p, 0);
  return prices.map((p) => p * s); // quitar margen (multiplicativo)
}

Deno.serve(async (req: Request) => {
  if (!KEY) return new Response(JSON.stringify({ ok: false, error: "ODDS_API_KEY no configurada" }), { status: 400 });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const sports: string[] = body.sports ?? ["soccer_epl"];
  const minEdge: number = body.minEdge ?? 0.02, maxOdds: number = body.maxOdds ?? 5;
  const out: any = { ok: true, sports: [], remaining: null, bookmakers: {} as Record<string, number>, value: [] as any[] };

  for (const sp of sports) {
    const url = `https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${KEY}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal`;
    const res = await fetch(url);
    out.remaining = res.headers.get("x-requests-remaining");
    if (!res.ok) { out.sports.push({ sp, error: res.status }); continue; }
    const events: any[] = await res.json();
    let withPin = 0;
    for (const ev of events) {
      const books = ev.bookmakers ?? [];
      for (const b of books) out.bookmakers[b.key] = (out.bookmakers[b.key] ?? 0) + 1;
      const pin = books.find((b: any) => b.key === "pinnacle");
      if (!pin) continue;
      withPin++;
      for (const mk of ["h2h", "totals"]) {
        const pm = pin.markets?.find((m: any) => m.key === mk);
        if (!pm) continue;
        // en totals solo la linea 2.5
        const pOut = mk === "totals" ? pm.outcomes.filter((o: any) => o.point === 2.5) : pm.outcomes;
        if (mk === "totals" && pOut.length !== 2) continue;
        const f = fair(pOut.map((o: any) => o.price));
        pOut.forEach((o: any, i: number) => {
          let best = { price: 0, book: "" };
          for (const b of books) {
            if (b.key === "pinnacle") continue;
            const m = b.markets?.find((x: any) => x.key === mk);
            const oo = m?.outcomes?.find((x: any) => x.name === o.name && (mk !== "totals" || x.point === 2.5));
            if (oo && oo.price > best.price) best = { price: oo.price, book: b.title };
          }
          const edge = best.price / f[i] - 1;
          if (best.price && edge >= minEdge && best.price <= maxOdds) {
            out.value.push({
              liga: sp, partido: `${ev.home_team} vs ${ev.away_team}`, inicio: ev.commence_time,
              mercado: mk === "h2h" ? "1X2" : "Goles 2.5", seleccion: mk === "totals" ? `${o.name} 2.5` : o.name,
              cuota_justa: +f[i].toFixed(3), mejor_cuota: best.price, casa: best.book, ventaja_pct: +(edge * 100).toFixed(1),
            });
          }
        });
      }
    }
    out.sports.push({ sp, eventos: events.length, con_pinnacle: withPin });
  }
  out.value.sort((a: any, b: any) => b.ventaja_pct - a.ventaja_pct);
  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
