const { chromium } = require('playwright');
const out = process.argv[2];
const C = { night: '#1A1530', deep: '#110D1C', ink: '#EFEAF7', rose: '#FF5A9D', rose2: '#D82F74', teal: '#2FCFB4', amber: '#F2A33A' };
const font = '<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700;800&family=Martian+Mono:wght@400;500&display=swap" rel="stylesheet">';
const mark = (fg, ac) => `<svg viewBox="0 0 64 64" width="100%" height="100%"><circle cx="32" cy="32" r="26" fill="none" stroke="${fg}" stroke-width="4.5"/><circle cx="32" cy="32" r="14.5" fill="none" stroke="${fg}" stroke-width="4" opacity=".35"/><path d="M32 32 L32 6 A26 26 0 0 1 54.5 19 Z" fill="${ac}"/><circle cx="46" cy="42" r="3.2" fill="${fg}"/><circle cx="32" cy="32" r="5" fill="${ac}"/></svg>`;
// Big decorative radar: rings, ticks, a soft sweep and labelled blips
function radar(size, blips = true) {
  const c = size / 2, R = c - 4;
  let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${C.rose}" stop-opacity=".18"/><stop offset="1" stop-color="${C.rose}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.rose}" stop-opacity="0"/><stop offset="1" stop-color="${C.rose}" stop-opacity=".45"/></linearGradient></defs>
  <circle cx="${c}" cy="${c}" r="${R}" fill="url(#g)"/>`;
  [1, .75, .5, .25].forEach(k => s += `<circle cx="${c}" cy="${c}" r="${R * k}" fill="none" stroke="${C.ink}" stroke-opacity=".13" stroke-width="1.5"/>`);
  s += `<line x1="${c - R}" y1="${c}" x2="${c + R}" y2="${c}" stroke="${C.ink}" stroke-opacity=".1"/><line x1="${c}" y1="${c - R}" x2="${c}" y2="${c + R}" stroke="${C.ink}" stroke-opacity=".1"/>`;
  for (let i = 0; i < 72; i++) { const a = i / 72 * 2 * Math.PI, l = i % 6 ? 6 : 14; s += `<line x1="${c + Math.cos(a) * R}" y1="${c + Math.sin(a) * R}" x2="${c + Math.cos(a) * (R - l)}" y2="${c + Math.sin(a) * (R - l)}" stroke="${C.ink}" stroke-opacity=".18"/>`; }
  // sweep wedge: from -150deg to -90deg
  const a0 = -115 * Math.PI / 180, a1 = -50 * Math.PI / 180;
  for (let i = 0; i < 30; i++) {
    const t0 = a0 + (a1 - a0) * i / 30, t1 = a0 + (a1 - a0) * (i + 1) / 30;
    s += `<path d="M${c} ${c} L${c + Math.cos(t0) * R} ${c + Math.sin(t0) * R} A${R} ${R} 0 0 1 ${c + Math.cos(t1) * R} ${c + Math.sin(t1) * R} Z" fill="${C.rose}" fill-opacity="${(0.22 * i / 30).toFixed(3)}"/>`;
  }
  s += `<line x1="${c}" y1="${c}" x2="${c + Math.cos(a1) * R}" y2="${c + Math.sin(a1) * R}" stroke="${C.rose}" stroke-width="3" stroke-linecap="round"/>`;
  // Labels sit to the LEFT of each blip so none run off the right edge.
  if (blips) [[-55, .5, C.rose, 'Leak found'], [15, .55, C.amber, 'DMCA sent'], [120, .35, C.teal, 'Removed']].forEach(([deg, r, col, lab]) => {
    const a = deg * Math.PI / 180, x = c + Math.cos(a) * R * r, y = c + Math.sin(a) * R * r;
    s += `<circle cx="${x}" cy="${y}" r="16" fill="${col}" fill-opacity=".18"/><circle cx="${x}" cy="${y}" r="6" fill="${col}"/>`;
    s += `<text x="${x - 18}" y="${y + 5}" text-anchor="end" fill="${col}" font-family="Martian Mono" font-size="${Math.max(11, size / 70)}" letter-spacing="1">${lab.toUpperCase()}</text>`;
  });
  s += `<circle cx="${c}" cy="${c}" r="9" fill="${C.rose}"/></svg>`;
  return s;
}
const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8">${font}<style>*{margin:0;box-sizing:border-box}body{width:${w}px;height:${h}px;overflow:hidden;background:${C.night};color:${C.ink};font-family:Unbounded,sans-serif;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 75% 50%, rgba(255,90,157,.10), transparent 60%), radial-gradient(600px 400px at 0% 100%, rgba(107,79,216,.18), transparent 70%), ${C.night}}
.label{white-space:nowrap;font:500 ${w > 1200 ? 15 : 10}px/1 'Martian Mono',monospace;letter-spacing:.22em;text-transform:uppercase;color:${C.rose};display:flex;align-items:center;gap:12px}
.label::before{content:"";width:28px;height:1.5px;background:currentColor}
.url{font:500 ${w > 1200 ? 17 : 11}px/1 'Martian Mono',monospace;letter-spacing:.12em;color:rgba(239,234,247,.7)}
</style></head><body><div class="bg"></div>${body}</body></html>`;

(async () => {
  const b = await chromium.launch();
  const shot = async (name, w, h, html, scale = 1) => {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await p.setContent(html, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/${name}` });
    await p.close();
  };
  // Profile pictures (X shows a circle, LinkedIn a square): mark centred with room for the crop
  const profile = page(400, 400, `<div style="position:absolute;inset:0;display:grid;place-items:center"><div style="width:236px;height:236px">${mark(C.ink, C.rose)}</div></div>`);
  await shot('x-profile-400.png', 400, 400, profile);
  await shot('linkedin-logo-400.png', 400, 400, profile);

  // X header 1500x500. Profile photo overlaps bottom-left (~x 0-330, y 300-500) and phones crop top/bottom,
  // so text sits centre-left between x 400-980, y 120-380.
  const xHeader = page(1500, 500, `
    <div style="position:absolute;right:-170px;top:-200px">${radar(900)}</div>
    <div style="position:absolute;left:400px;top:118px;display:grid;gap:22px;width:620px">
      <span class="label">DMCA takedowns for creators</span>
      <div style="font-weight:800;font-size:64px;line-height:1.02;letter-spacing:-.045em">Leaked today.<br><span style="color:${C.rose}">Gone tomorrow.</span></div>
      <span class="url">www.sentryvo.com &nbsp;·&nbsp; Protect what you create</span>
    </div>`);
  await shot('x-header-1500x500.png', 1500, 500, xHeader);

  // LinkedIn cover 1128x191. The page logo overlaps bottom-left (~x 0-240), so text starts at x 270.
  const liBody = `
    <div style="position:absolute;right:-120px;top:-330px">${radar(760, false)}</div>
    <div style="position:absolute;left:270px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:12px">
      <span class="label">Leak detection &amp; DMCA takedowns for creators</span>
      <div style="font-weight:800;font-size:36px;line-height:1;letter-spacing:-.04em;white-space:nowrap">Leaked today. <span style="color:${C.rose}">Gone tomorrow.</span></div>
      <span class="url">www.sentryvo.com</span>
    </div>`;
  await shot('linkedin-cover-1128x191.png', 1128, 191, page(1128, 191, liBody));
  await shot('linkedin-cover-2256x382.png', 1128, 191, page(1128, 191, liBody), 2);
  await b.close();
})();
