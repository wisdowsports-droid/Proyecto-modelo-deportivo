// Diagnostico: formatos de consulta que acepta ESPN para col.1
// Resultado 2026-09-29: dates=YYYYMMDD y dates=YYYYMM funcionan; los rangos
// YYYYMMDD-YYYYMMDD devuelven 400; dates=YYYY se corta en 100 partidos.
Deno.serve(async (_req: Request) => {
  const out: any = {};
  const B = "https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/scoreboard";
  const H = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };
  const tries: Record<string, string> = {
    day: `${B}?dates=20260920`,
    range_short: `${B}?dates=20260901-20260928`,
    month: `${B}?dates=202608`,
    year: `${B}?dates=2025`,
  };
  for (const [k, u] of Object.entries(tries)) {
    try {
      const r = await fetch(u, { headers: H });
      const t = await r.text();
      let s: any = t.slice(0, 120);
      try { const j = JSON.parse(t); const ev = j.events ?? []; s = { n: ev.length, first: ev[0]?.date, last: ev[ev.length - 1]?.date }; } catch (_e) { /* html */ }
      out[k] = { status: r.status, s };
    } catch (e) { out[k] = String(e); }
  }
  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
