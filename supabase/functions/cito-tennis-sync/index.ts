import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Trae resultados de tenis (todos los niveles) de Cito Tennis API, 1 llamada por dia (page_size 500).
// body: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }  (por defecto: ayer). Max 8 dias por llamada (limite 10/min).
// Plan gratis: 500 llamadas/mes, 30 dias de historial. Lleva la cuenta en cito_usage.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const KEY = (Deno.env.get("TENNIS_API_KEY") ?? "").trim();
const BASE = "https://api.citoapi.com/api/v1";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const MONTH_CAP = 450;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function games(score: string): [number, number] {
  // el score viene desde el punto de vista del ganador: "6-4 3-6 7-6(5)"
  let w = 0, l = 0;
  for (const s of (score ?? "").split(/\s+/)) {
    const m = s.match(/^(\d+)-(\d+)/);
    if (m) { w += +m[1]; l += +m[2]; }
  }
  return [w, l];
}

async function used(): Promise<number> {
  const since = iso(Date.now() - 30 * 86400e3);
  const { data } = await supabase.from("cito_usage").select("calls").gte("day", since);
  return (data ?? []).reduce((a: number, r: any) => a + r.calls, 0);
}
async function bump() {
  const d = iso(Date.now());
  const { data } = await supabase.from("cito_usage").select("calls").eq("day", d).maybeSingle();
  await supabase.from("cito_usage").upsert({ day: d, calls: (data?.calls ?? 0) + 1 });
}

Deno.serve(async (req: Request) => {
  let b: any = {}; try { b = await req.json(); } catch (_e) { /* */ }
  const y = iso(Date.now() - 86400e3);
  const from = b.from ?? y, to = b.to ?? from;
  const days: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to) && days.length < 8; t += 86400e3) days.push(iso(t));
  const out: any[] = [];
  for (const d of days) {
    if (await used() >= MONTH_CAP) { out.push({ d, skipped: "tope mensual" }); break; }
    let page = 1, n = 0;
    while (true) {
      const r = await fetch(`${BASE}/tennis/matches/completed?date=${d}&page_size=500&page=${page}`, { headers: { "x-api-key": KEY } });
      await bump();
      if (!r.ok) { out.push({ d, error: r.status, body: (await r.text()).slice(0, 200) }); break; }
      const j = await r.json();
      const rows = (j.items ?? []).filter((m: any) => m.winner?.name && m.loser?.name).map((m: any) => {
        const [wg, lg] = games(m.score);
        return { id: m.id, match_date: m.match_date ?? d, tour: m.tour, level: m.level, category: m.category, surface: m.surface,
          round: m.round, best_of: m.best_of, tournament_name: m.tournament_name, winner_id: m.winner_id, winner_name: m.winner.name,
          loser_id: m.loser_id, loser_name: m.loser.name, score: m.score, outcome: m.outcome, w_games: wg, l_games: lg };
      });
      if (rows.length) await supabase.from("cito_tennis_matches").upsert(rows);
      n += rows.length;
      if (!j.has_next) break;
      page++; await sleep(7000);
    }
    out.push({ d, matches: n });
    await sleep(7000);
  }
  return new Response(JSON.stringify({ ok: true, used_30d: await used(), days: out }), { headers: { "Content-Type": "application/json" } });
});
