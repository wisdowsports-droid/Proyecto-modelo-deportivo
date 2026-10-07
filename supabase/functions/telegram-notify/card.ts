// Tarjetas 1080x1350 (formato historia / feed) para el canal y para compartir en redes.
// Se arman como SVG y se convierten a PNG con resvg (wasm) dentro de la funcion.

export type FreePick = { home: string; away: string; time: string; league?: string; label: string; prob: number };
export type ResultPick = { home: string; away: string; label: string; score: string | null; hit: boolean | null };

const W = 1080, H = 1350;
const C = { bg1: "#14305C", bg2: "#08142A", card: "#112748", line: "#1E3A66", ink: "#F2F5FA", sub: "#A9B8D0", win: "#3CCB8F", loss: "#F07A66", gold: "#E3B85A" };

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const LOGO = (tx: number, ty: number, s: number) => `
<g transform="translate(${tx} ${ty}) scale(${s / 512})">
  <rect width="512" height="512" rx="112" fill="#0A1830" stroke="#2A4A7A" stroke-width="6"/>
  <g transform="translate(24 4)">
    <g stroke="${C.gold}" stroke-width="18" stroke-linecap="round">
      <line x1="92" y1="214" x2="140" y2="214"/><line x1="72" y1="256" x2="140" y2="256"/><line x1="92" y1="298" x2="140" y2="298"/>
    </g>
    <rect x="168" y="132" width="56" height="248" rx="14" fill="${C.ink}"/>
    <path d="M224 262 L340 380" stroke="${C.ink}" stroke-width="56" stroke-linecap="round"/>
    <path d="M224 262 L318 168" stroke="${C.win}" stroke-width="56" stroke-linecap="round"/>
    <path d="M276 118 L392 118 L392 234 Z" fill="${C.win}" stroke="${C.win}" stroke-width="10" stroke-linejoin="round"/>
  </g>
</g>`;

function frame(title: string, subtitle: string, body: string, footer: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<circle cx="980" cy="120" r="260" fill="${C.win}" opacity="0.06"/>
${LOGO(72, 70, 112)}
<text x="204" y="118" font-family="Inter" font-weight="800" font-size="40" fill="${C.ink}" letter-spacing="2">KINETIK PICKS</text>
<text x="204" y="160" font-family="Inter" font-weight="400" font-size="26" fill="${C.sub}">Probabilidades reales · aciertos y fallos</text>
<text x="72" y="300" font-family="Inter" font-weight="800" font-size="78" fill="${C.ink}">${x(title)}</text>
<text x="72" y="352" font-family="Inter" font-weight="600" font-size="34" fill="${C.gold}">${x(subtitle)}</text>
${body}
<line x1="72" y1="1218" x2="${W - 72}" y2="1218" stroke="${C.line}" stroke-width="2"/>
<text x="72" y="1268" font-family="Inter" font-weight="600" font-size="28" fill="${C.ink}">t.me/kinetikpics</text>
<text x="${W - 72}" y="1268" text-anchor="end" font-family="Inter" font-weight="400" font-size="24" fill="${C.sub}">${x(footer)}</text>
</svg>`;
}

export function freeCardSvg(dateLabel: string, picks: FreePick[]) {
  const n = picks.length;
  const top = 410, gap = 28, avail = 1180 - top;
  const h = Math.min(250, (avail - gap * (n - 1)) / Math.max(n, 1));
  const body = picks.map((p, i) => {
    const y = top + i * (h + gap);
    const pct = Math.round(p.prob * 100);
    const barW = 300;
    return `
<g transform="translate(72 ${y})">
  <rect width="${W - 144}" height="${h}" rx="28" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>
  <text x="40" y="58" font-family="Inter" font-weight="600" font-size="26" fill="${C.sub}">${x(cut((p.league ? p.league + " · " : "") + p.time, 46))}</text>
  <text x="40" y="108" font-family="Inter" font-weight="700" font-size="36" fill="${C.ink}">${x(cut(p.home + " vs " + p.away, 40))}</text>
  <text x="40" y="${h - 44}" font-family="Inter" font-weight="800" font-size="44" fill="${C.win}">${x(cut(p.label, 26))}</text>
  <text x="${W - 144 - 40}" y="${h - 44}" text-anchor="end" font-family="Inter" font-weight="800" font-size="72" fill="${C.ink}">${pct}%</text>
  <rect x="${W - 144 - 40 - barW}" y="${h - 30}" width="${barW}" height="10" rx="5" fill="${C.line}"/>
  <rect x="${W - 144 - 40 - barW}" y="${h - 30}" width="${(barW * pct) / 100}" height="10" rx="5" fill="${C.win}"/>
</g>`;
  }).join("");
  return frame("GRATIS DE HOY", dateLabel, body, "Probabilidad del modelo · +18");
}

export function resultsCardSvg(dateLabel: string, rows: ResultPick[], dayHits: number, dayTotal: number, liveHits: number, liveTotal: number) {
  const top = 470, rowH = 150, gap = 22;
  const list = rows.slice(0, 4).map((r, i) => {
    const y = top + i * (rowH + gap);
    const col = r.hit == null ? C.sub : r.hit ? C.win : C.loss;
    const mark = r.hit == null
      ? `<line x1="-18" y1="0" x2="18" y2="0" stroke="${col}" stroke-width="8" stroke-linecap="round"/>`
      : r.hit
        ? `<path d="M-18 0 L-5 14 L20 -14" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="M-15 -15 L15 15 M15 -15 L-15 15" stroke="${col}" stroke-width="9" stroke-linecap="round"/>`;
    return `
<g transform="translate(72 ${y})">
  <rect width="${W - 144}" height="${rowH}" rx="26" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>
  <g transform="translate(76 ${rowH / 2})"><circle r="38" fill="${col}" opacity="0.16"/>${mark}</g>
  <text x="146" y="64" font-family="Inter" font-weight="700" font-size="34" fill="${C.ink}">${x(cut(r.home + " vs " + r.away, 32))}</text>
  <text x="146" y="110" font-family="Inter" font-weight="600" font-size="30" fill="${col}">${x(cut(r.label, 30))}</text>
  <text x="${W - 144 - 40}" y="${rowH / 2 + 18}" text-anchor="end" font-family="Inter" font-weight="800" font-size="52" fill="${C.ink}">${x(r.score ?? "—")}</text>
</g>`;
  }).join("");
  const livePct = liveTotal ? Math.round((100 * liveHits) / liveTotal) : 0;
  const head = `
<text x="72" y="430" font-family="Inter" font-weight="800" font-size="46" fill="${C.ink}">${dayHits} de ${dayTotal} acertados</text>`;
  const foot = `
<g transform="translate(72 1100)">
  <rect width="${W - 144}" height="86" rx="22" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>
  <text x="36" y="55" font-family="Inter" font-weight="600" font-size="30" fill="${C.sub}">En vivo desde el inicio</text>
  <text x="${W - 144 - 36}" y="56" text-anchor="end" font-family="Inter" font-weight="800" font-size="34" fill="${C.ink}">${liveHits} de ${liveTotal} · ${livePct}%</text>
</g>`;
  return frame("ASÍ NOS FUE", dateLabel, head + list + foot, "Publicamos aciertos y fallos · +18");
}

// ---- PNG con resvg-wasm (fuentes Inter descargadas una vez por instancia) ----
let ready: Promise<{ Resvg: any; fonts: Uint8Array[] }> | null = null;
async function engine() {
  if (!ready) ready = (async () => {
    const mod = await import("npm:@resvg/resvg-wasm@2.6.2");
    await mod.initWasm(fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm"));
    const urls = [400, 600, 700, 800].map((w) => `https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-${w}-normal.ttf`);
    const fonts = await Promise.all(urls.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
    return { Resvg: mod.Resvg, fonts };
  })();
  return ready;
}
export async function svgToPng(svg: string): Promise<Uint8Array> {
  const { Resvg, fonts } = await engine();
  const r = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: "Inter", loadSystemFonts: false }, fitTo: { mode: "original" } });
  return r.render().asPng();
}
