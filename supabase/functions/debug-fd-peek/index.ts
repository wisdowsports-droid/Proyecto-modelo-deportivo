// Diagnostico: muestra encabezado y primeras/ultimas filas de los
// calendarios de football-data.co.uk (fixtures.csv y new_league_fixtures.csv).
Deno.serve(async (_req: Request) => {
  const out: any = {};
  for (const f of ["fixtures.csv", "new_league_fixtures.csv"]) {
    const res = await fetch(`https://www.football-data.co.uk/${f}`);
    const t = await res.text();
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    out[f] = { status: res.status, lines: lines.length, head: lines.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 200))), last: lines.slice(-2).map((l) => l.slice(0, 120)) };
  }
  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
