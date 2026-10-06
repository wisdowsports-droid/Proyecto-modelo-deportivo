import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Calificacion de respaldo con ESPN (gratis). Busca partidos de futbol que ya
// se jugaron y siguen 'scheduled' (porque su fuente principal publica tarde:
// football-data sube resultados 1-2 veces por semana, y la consulta de
// resultados de The Odds API no cubre todas las ligas) y los cierra con el
// marcador de ESPN. Solo cierra cuando hay UN partido que coincide por liga,
// fecha (+-36 h) y nombres de ambos equipos.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")["default"];
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const HEADERS = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };

// etiqueta de liga en nuestra base -> codigos de ESPN donde buscar
const ESPN: Record<string, string[]> = {
  "EPL": ["eng.1"], "Championship - England": ["eng.2"], "League One - England": ["eng.3"],
  "La Liga - Spain": ["esp.1"], "La Liga 2 - Spain": ["esp.2"],
  "Serie A - Italy": ["ita.1"], "Serie B - Italy": ["ita.2"],
  "Bundesliga - Germany": ["ger.1"], "2. Bundesliga - Germany": ["ger.2"],
  "Ligue 1 - France": ["fra.1"], "Ligue 2 - France": ["fra.2"],
  "Eredivisie - Netherlands": ["ned.1"], "Pro League - Belgium": ["bel.1"], "Primeira Liga - Portugal": ["por.1"],
  "Super Lig - Turkey": ["tur.1"], "Super League - Greece": ["gre.1"], "Premiership - Scotland": ["sco.1"],
  "Bundesliga - Austria": ["aut.1"], "Superliga - Denmark": ["den.1"], "Eliteserien - Norway": ["nor.1"],
  "Allsvenskan - Sweden": ["swe.1"], "Super League - Switzerland": ["sui.1"], "Ekstraklasa - Poland": ["pol.1"],
  "J1 League - Japan": ["jpn.1"],
  "Primera División - Argentina": ["arg.1"], "Brazil Série A": ["bra.1"], "Liga MX": ["mex.1"], "MLS": ["usa.1"],
  "Liga BetPlay (Colombia Primera A)": ["col.1"], "Primera División - Uruguay": ["uru.1"], "Liga 1 - Peru": ["per.1"],
  "Primera División - Chile": ["chi.1"], "LigaPro - Ecuador": ["ecu.1"], "Primera División - Paraguay": ["par.1"],
  "UEFA Champions League": ["uefa.champions"], "UEFA Champions League Women": ["uefa.wchampions"],
  "Copa Libertadores": ["conmebol.libertadores"], "Copa Sudamericana": ["conmebol.sudamericana"],
  "UEFA Nations League": ["uefa.nations", "fifa.friendly", "fifa.worldq.uefa"],
};

const STOP = new Set(["fc", "cf", "sc", "ac", "as", "cd", "ud", "rc", "sd", "club", "de", "del", "la", "el", "the", "w", "women", "fem", "afc", "cfc", "1", "u21"]);
function tokens(name: string): string[] {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.\-()'/]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}
// coincidencia de nombre: algun token igual, o uno es prefijo del otro ("sp" ~ "sporting", "inter" ~ "internazionale")
function sameTeam(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  for (const x of A) for (const y of B) {
    if (x === y && x.length >= 2) return true;
    if (x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= (x.length > 3 && y.length > 3 ? 4 : 2)) return true;
  }
  return false;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const cache = new Map<string, any[]>();
async function scoreboard(code: string, day: string): Promise<any[]> {
  const k = code + day;
  if (cache.has(k)) return cache.get(k)!;
  let ev: any[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${day}`, { headers: HEADERS });
      if (r.ok) { ev = (await r.json()).events ?? []; break; }
      if (r.status === 400 || r.status === 404) break;
    } catch (_e) { /* reintento */ }
    await new Promise((res) => setTimeout(res, 600 * (i + 1)));
  }
  cache.set(k, ev);
  return ev;
}

Deno.serve(async (_req: Request) => {
  const now = Date.now();
  const { data: pending, error } = await supabase.from("fixtures")
    .select("id, league, home_team, away_team, commence_time")
    .eq("sport", "soccer").eq("status", "scheduled")
    // 1 h 45 min despues del inicio ya puede haber terminado; solo se cierra si ESPN lo marca "completed"
    .lt("commence_time", new Date(now - 105 * 60000).toISOString())
    .gt("commence_time", new Date(now - 10 * 86400000).toISOString());
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });

  const out: any = { ok: true, pending: pending?.length ?? 0, settled: 0, postponed: 0, noMatch: [] as string[], noLeague: [] as string[] };
  for (const f of pending ?? []) {
    const codes = ESPN[f.league];
    if (!codes) { if (!out.noLeague.includes(f.league)) out.noLeague.push(f.league); continue; }
    const t = Date.parse(f.commence_time);
    const cands: any[] = [];
    for (const code of codes) {
      for (const day of [ymd(t - 86400000), ymd(t)]) {
        for (const e of await scoreboard(code, day)) {
          if (Math.abs(Date.parse(e.date) - t) > 36 * 3600000) continue;
          const comp = e.competitions?.[0];
          const h = comp?.competitors?.find((c: any) => c.homeAway === "home");
          const a = comp?.competitors?.find((c: any) => c.homeAway === "away");
          if (!h || !a) continue;
          if (sameTeam(f.home_team, h.team?.displayName ?? "") && sameTeam(f.away_team, a.team?.displayName ?? "")) cands.push({ e, h, a });
        }
      }
    }
    const uniq = new Map(cands.map((c) => [c.e.id, c]));
    if (uniq.size !== 1) { out.noMatch.push(`${f.league}: ${f.home_team} v ${f.away_team} (${uniq.size})`); continue; }
    const { e, h, a } = [...uniq.values()][0];
    const st = e.status?.type ?? {};
    if (/POSTPONED|CANCELED|ABANDONED/i.test(st.name ?? "")) {
      await supabase.from("fixtures").update({ status: "postponed" }).eq("id", f.id).eq("status", "scheduled");
      out.postponed++; continue;
    }
    if (!st.completed) continue;
    const hs = parseInt(h.score, 10), as = parseInt(a.score, 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    const { data } = await supabase.from("fixtures").update({ status: "finished", home_score: hs, away_score: as })
      .eq("id", f.id).eq("status", "scheduled").select("id");
    out.settled += data?.length ?? 0;
  }
  return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json" } });
});
