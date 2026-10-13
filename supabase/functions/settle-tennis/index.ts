import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Cierra partidos de tenis (ATP y WTA) con el scoreboard publico de ESPN (gratis, sin clave).
// - Jugado y terminado: guarda sets ganados (home_score / away_score) y status 'finished'.
// - Retiro o walkover: status 'cancelled' (no cuenta en el record).
// - Cruce que nunca se jugo (algun jugador aparece en el torneo pero no ese partido) 48 h despues: 'cancelled'.
// body opcional: { dry: true } para ver que haria sin escribir.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function norm(s: string) {
  return (s ?? "").toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.\-'’]/g, " ").replace(/\s+/g, " ").trim();
}
const toks = (s: string) => norm(s).split(" ").filter((t) => t.length >= 3);
function samePlayer(a: string, b: string): boolean {
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return false;
  // apellido (ultimo token) de uno aparece en el otro, o comparten un token de 4+ letras
  if (B.includes(A[A.length - 1]) || A.includes(B[B.length - 1])) return true;
  return A.some((x) => x.length >= 4 && B.includes(x));
}
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

type M = { t: number; state: string; detail: string; p: { name: string; win: boolean; sets: number }[] };

async function board(tour: string, d: string): Promise<M[]> {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${d}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return [];
    const j = await r.json();
    const out: M[] = [];
    for (const ev of j.events ?? []) for (const g of ev.groupings ?? []) {
      if (!/singles/i.test(g.grouping?.displayName ?? "")) continue;
      for (const c of g.competitions ?? []) {
        const cs = c.competitors ?? [];
        if (cs.length !== 2) continue;
        const games = cs.map((x: any) => (x.linescores ?? []).map((l: any) => Number(l.value)));
        const sets = [0, 0];
        for (let i = 0; i < Math.min(games[0].length, games[1].length); i++) {
          if (games[0][i] > games[1][i]) sets[0]++; else if (games[1][i] > games[0][i]) sets[1]++;
        }
        out.push({
          t: Date.parse(c.date), state: c.status?.type?.state ?? "", detail: `${c.status?.type?.detail ?? ""} ${c.status?.type?.description ?? ""}`,
          p: cs.map((x: any, i: number) => ({ name: x.athlete?.displayName ?? x.athlete?.fullName ?? "", win: !!x.winner, sets: sets[i] })),
        });
      }
    }
    return out;
  } catch (_e) { return []; }
}

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch (_e) { /* */ }
  const { data: fx } = await supabase.from("fixtures").select("id, league, home_team, away_team, commence_time")
    .eq("sport", "tennis").eq("status", "scheduled")
    .lt("commence_time", new Date(Date.now() - 2 * 3600e3).toISOString())
    .gt("commence_time", new Date(Date.now() - 12 * 86400e3).toISOString());
  if (!fx?.length) return new Response(JSON.stringify({ ok: true, pending: 0 }), { headers: { "Content-Type": "application/json" } });

  const days = new Set<string>();
  for (const f of fx) { const t = Date.parse(f.commence_time); [t - 86400e3, t, t + 86400e3].forEach((x) => days.add(ymd(x))); }
  const all: M[] = [];
  await Promise.all([...days].flatMap((d) => ["atp", "wta"].map(async (tour) => { all.push(...await board(tour, d)); })));
  const seen = new Set<string>();
  const ms = all.filter((m) => { const k = `${m.t}|${m.p[0].name}|${m.p[1].name}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const out: any[] = [];
  for (const f of fx) {
    const t = Date.parse(f.commence_time);
    const near = ms.filter((m) => Math.abs(m.t - t) <= 36 * 3600e3);
    const hit = near.filter((m) =>
      (samePlayer(f.home_team, m.p[0].name) && samePlayer(f.away_team, m.p[1].name)) ||
      (samePlayer(f.home_team, m.p[1].name) && samePlayer(f.away_team, m.p[0].name)));
    let upd: any = null, why = "";
    if (hit.length === 1) {
      const m = hit[0];
      const hi = samePlayer(f.home_team, m.p[0].name) ? 0 : 1, ai = 1 - hi;
      if (m.state !== "post") { why = "aun no termina"; }
      else if (/ret|walkover|w\/o|withdr|default/i.test(m.detail) || (!m.p[0].win && !m.p[1].win)) {
        upd = { status: "cancelled" }; why = "retiro/walkover";
      } else {
        const h = m.p[hi], a = m.p[ai];
        if ((h.win && h.sets > a.sets) || (a.win && a.sets > h.sets)) { upd = { status: "finished", home_score: h.sets, away_score: a.sets }; why = "terminado"; }
        else { upd = { status: "cancelled" }; why = "marcador incompleto (retiro)"; }
      }
    } else if (hit.length === 0 && Date.now() - t > 48 * 3600e3) {
      const inEvent = ms.some((m) => Math.abs(m.t - t) <= 4 * 86400e3 &&
        m.p.some((p) => samePlayer(f.home_team, p.name) || samePlayer(f.away_team, p.name)));
      if (inEvent) { upd = { status: "cancelled" }; why = "ese cruce no se jugo"; } else why = "sin datos en ESPN";
    } else why = hit.length > 1 ? "coincidencia ambigua" : "sin datos aun";
    if (upd && !body.dry) await supabase.from("fixtures").update(upd).eq("id", f.id);
    out.push({ id: f.id, match: `${f.home_team} vs ${f.away_team}`, why, ...(upd ?? {}) });
  }
  return new Response(JSON.stringify({ ok: true, espn_matches: ms.length, results: out }), { headers: { "Content-Type": "application/json" } });
});
