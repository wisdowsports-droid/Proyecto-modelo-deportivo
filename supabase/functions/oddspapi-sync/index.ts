import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// OddsPapi (plan gratis: 250 consultas/mes). Una vez al dia:
//  - cuotas de BetPlay y de Pinnacle para todas nuestras ligas (1 consulta por casa: odds-by-tournaments)
//  - precio justo de Pinnacle (sin margen) y ventaja de BetPlay: edge = precio BetPlay x prob. justa - 1
//  - guarda todo en bp_lines y las senales (edge >= 3 %, cuota <= 5) en bp_value
// Mercados: 1X2, ambos anotan, mas/menos 1,5 / 2,5 / 3,5 goles.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const KEY = Deno.env.get("ODDSPAPI_KEY") ?? Deno.env.get("ODDS_PAPI_KEY") ?? Deno.env.get("ODDS_PAPi_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const B = "https://api.oddspapi.io/v4";
const MONTHLY_CAP = 225;
const MIN_EDGE = 0.03, MAX_PRICE = 5;

// El plan gratis acepta maximo 5 torneos por consulta. Grupos:
//  0: Colombia, Argentina, Brasil, Liga MX, MLS      1: Chile, Peru, Ecuador, Uruguay, Paraguay
//  2: Libertadores, Sudamericana, Nations League, Premier, LaLiga
//  3: Serie A, Bundesliga, Ligue 1, Champions, Europa League
// Cada dia: grupos 0 y 1, y en dias alternos el 2 o el 3 (2 consultas por grupo: BetPlay y Pinnacle) => ~180/mes.
const GROUPS = [[27070, 155, 325, 27464, 242], [27665, 406, 240, 278, 27098], [384, 480, 23755, 17, 8], [23, 35, 34, 7, 679]];
const MK: Record<number, { m: string; line: number | null; o: Record<number, string> }> = {
  101: { m: "1x2", line: null, o: { 101: "1", 102: "X", 103: "2" } },
  104: { m: "btts", line: null, o: { 104: "Yes", 105: "No" } },
  108: { m: "totals", line: 1.5, o: { 108: "Over", 109: "Under" } },
  1010: { m: "totals", line: 2.5, o: { 1010: "Over", 1011: "Under" } },
  1012: { m: "totals", line: 3.5, o: { 1012: "Over", 1013: "Under" } },
};

const STOP = new Set(["fc", "cf", "sc", "ac", "as", "cd", "ud", "rc", "sd", "club", "de", "del", "la", "el", "the", "atletico", "deportivo", "ca", "cs", "ec", "se", "sp", "rj", "mg", "ba", "pr", "united", "city"]);
function tokens(name: string): string[] {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.\-()'/&]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}
function sameTeam(a: string, b: string): boolean {
  const A = tokens(a), Bt = tokens(b);
  if (!A.length || !Bt.length) return a.toLowerCase() === b.toLowerCase();
  for (const x of A) for (const y of Bt) {
    if (x === y && x.length >= 3) return true;
    if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  }
  return false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (_req: Request) => {
  if (!KEY) return new Response(JSON.stringify({ ok: false, error: "clave de OddsPapi no configurada" }), { status: 500 });
  const t0 = Date.now(), month = new Date().toISOString().slice(0, 7), log: string[] = [];
  let { data: usage } = await supabase.from("op_usage").select("*").eq("month", month).maybeSingle();
  if (!usage) { await supabase.from("op_usage").insert({ month }); usage = { month, calls: 0, meta: {} }; }
  let calls: number = usage.calls;
  const api = async (path: string) => {
    if (calls >= MONTHLY_CAP) { log.push("tope mensual alcanzado"); return null; }
    calls++;
    const r = await fetch(`${B}/${path}${path.includes("?") ? "&" : "?"}apiKey=${KEY}`);
    const t = await r.text();
    try { const j = JSON.parse(t); if (!r.ok) { log.push(`${path.split("?")[0]} ${r.status}: ${t.slice(0, 200)}`); return null; } return j; }
    catch (_e) { log.push(`${path.split("?")[0]} ${r.status}: ${t.slice(0, 200)}`); return null; }
  };
  let body: any = {}; try { body = await _req.json(); } catch (_e) { /* */ }
  const day = Math.floor(Date.now() / 86400e3);
  const groups: number[] = Array.isArray(body.groups) ? body.groups : [0, 1, day % 2 === 0 ? 2 : 3];
  const bp: any[] = [], pin: any[] = [];
  for (const g of groups) {
    const ids = (GROUPS[g] ?? []).join(","); if (!ids) continue;
    const b = await api(`odds-by-tournaments?bookmaker=betplay&tournamentIds=${ids}&oddsFormat=decimal`);
    await sleep(1200);
    if (!Array.isArray(b)) continue;
    if (!b.length) { log.push(`grupo ${g}: BetPlay sin partidos`); continue; } // no gasta la consulta de Pinnacle
    const p = await api(`odds-by-tournaments?bookmaker=pinnacle&tournamentIds=${ids}&oddsFormat=decimal`);
    await sleep(1200);
    bp.push(...b); if (Array.isArray(p)) pin.push(...p);
  }
  if (!bp.length) {
    await supabase.from("op_usage").update({ calls }).eq("month", month);
    return new Response(JSON.stringify({ ok: false, calls_month: calls, log }), { status: 502 });
  }

  // nombres de equipos (se recargan solo si aparece uno desconocido)
  const needed = new Set<number>();
  for (const f of bp) { needed.add(Number(f.participant1Id)); needed.add(Number(f.participant2Id)); }
  const names = new Map<number, string>();
  const { data: known } = await supabase.from("op_participants").select("id, name").in("id", [...needed]);
  for (const k of known ?? []) names.set(k.id, k.name);
  if ([...needed].some((i) => !names.has(i))) {
    await sleep(1200);
    const all = await api("participants?sportId=10");
    if (all && typeof all === "object") {
      const rows = Object.entries(all).map(([id, name]) => ({ id: Number(id), name: String(name) }));
      for (let i = 0; i < rows.length; i += 2000) await supabase.from("op_participants").upsert(rows.slice(i, i + 2000));
      for (const id of needed) if (all[String(id)]) names.set(id, String(all[String(id)]));
    }
  }

  const pinBy = new Map<string, any>(); for (const f of pin) pinBy.set(f.fixtureId, f);
  const now = Date.now();
  const { data: ours } = await supabase.from("fixtures").select("id, home_team, away_team, commence_time")
    .eq("sport", "soccer").gt("commence_time", new Date(now - 3 * 3600e3).toISOString())
    .lt("commence_time", new Date(now + 8 * 86400e3).toISOString());
  const price = (f: any, bk: string, mid: number, oid: number) => {
    const p = f?.bookmakerOdds?.[bk]?.markets?.[String(mid)]?.outcomes?.[String(oid)]?.players?.["0"];
    return p && p.active !== false && Number(p.price) > 1 ? Number(p.price) : null;
  };

  const lines: any[] = [], signals: any[] = [];
  let matched = 0;
  for (const f of bp) {
    const kick = Date.parse(f.startTime);
    if (!(kick > now + 15 * 60e3 && kick < now + 7 * 86400e3)) continue;
    const home = names.get(Number(f.participant1Id)) ?? String(f.participant1Id);
    const away = names.get(Number(f.participant2Id)) ?? String(f.participant2Id);
    const m = (ours ?? []).filter((o: any) => Math.abs(Date.parse(o.commence_time) - kick) <= 3 * 3600e3 &&
      sameTeam(o.home_team, home) && sameTeam(o.away_team, away));
    const fixture_id = m.length === 1 ? m[0].id : null; if (fixture_id) matched++;
    const p = pinBy.get(f.fixtureId);
    for (const [midS, def] of Object.entries(MK)) {
      const mid = Number(midS), oids = Object.keys(def.o).map(Number);
      const pp = oids.map((o) => price(p, "pinnacle", mid, o));
      const fair = pp.every((x) => x) ? (() => { const inv = pp.map((x) => 1 / x!); const s = inv.reduce((a, b) => a + b, 0); return inv.map((x) => x / s); })() : null;
      oids.forEach((oid, i) => {
        const b = price(f, "betplay", mid, oid); if (!b) return;
        const row: any = {
          op_fixture_id: f.fixtureId, outcome_id: oid, fixture_id, tournament_id: f.tournamentId, home, away, kickoff: f.startTime,
          market: def.m, selection: def.o[oid], line: def.line, bp_price: b, pin_price: pp[i], pin_fair: fair ? +fair[i].toFixed(4) : null,
          edge: fair ? +(b * fair[i] - 1).toFixed(4) : null, updated_at: new Date().toISOString(),
        };
        lines.push(row);
        if (row.edge != null && row.edge >= MIN_EDGE && b <= MAX_PRICE) {
          const { tournament_id: _t, updated_at: _u, ...sig } = row; signals.push(sig);
        }
      });
    }
  }
  for (let i = 0; i < lines.length; i += 500) await supabase.from("bp_lines").upsert(lines.slice(i, i + 500));
  // la senal se registra la primera vez que aparece (no se sobrescribe: asi se mide de forma honesta)
  if (signals.length) await supabase.from("bp_value").upsert(signals, { onConflict: "op_fixture_id,outcome_id", ignoreDuplicates: true });
  await supabase.from("op_usage").update({ calls }).eq("month", month);
  return new Response(JSON.stringify({
    ok: true, calls_month: calls, betplay_fixtures: bp.length, pinnacle_fixtures: pin.length, matched, lines: lines.length,
    signals: signals.length, log, ms: Date.now() - t0,
  }, null, 1), { headers: { "Content-Type": "application/json" } });
});
