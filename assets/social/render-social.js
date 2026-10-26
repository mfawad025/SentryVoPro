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

  // ---------- Profile pictures for the other platforms ----------
  // All of them crop to a circle, so the mark stays well inside it.
  const prof = (size) => page(size, size, `<div style="position:absolute;inset:0;display:grid;place-items:center"><div style="width:${Math.round(size * .59)}px;height:${Math.round(size * .59)}px">${mark(C.ink, C.rose)}</div></div>`);
  for (const [name, size] of [['youtube-profile-800.png', 800], ['instagram-profile-1080.png', 1080], ['tiktok-profile-1080.png', 1080],
    ['telegram-avatar-640.png', 640], ['facebook-profile-720.png', 720]]) {
    await shot(name, size, size, prof(size));
  }

  // ---------- YouTube banner 2560x1440 ----------
  // TV shows all of it, desktop a 2560x423 strip, phones only the centre
  // 1546x423 (x 507-2053, y 508-931): everything that matters sits there.
  const ytBanner = page(2560, 1440, `
    <div style="position:absolute;left:1290px;top:150px;opacity:.9">${radar(1140)}</div>
    <div style="position:absolute;left:-260px;top:620px;opacity:.35">${radar(900, false)}</div>
    <div style="position:absolute;left:560px;top:508px;width:1000px;height:423px;display:flex;flex-direction:column;justify-content:center;gap:26px">
      <span class="label" style="font-size:20px">Leak detection &amp; DMCA takedowns for creators</span>
      <div style="font-weight:800;font-size:92px;line-height:1;letter-spacing:-.045em">Leaked today.<br><span style="color:${C.rose}">Gone tomorrow.</span></div>
      <span class="url" style="font-size:24px">www.sentryvo.com &nbsp;·&nbsp; Free scan</span>
    </div>`);
  await shot('youtube-banner-2560x1440.png', 2560, 1440, ytBanner);

  // ---------- Facebook page cover 1640x624 ----------
  // Desktop shows it all; phones crop the sides to roughly the middle
  // 1100 px, so the text stays inside x 270-1370.
  const fbCover = page(1640, 624, `
    <div style="position:absolute;right:-180px;top:-260px;opacity:.85">${radar(1000, false)}</div>
    <div style="position:absolute;left:290px;top:0;bottom:0;width:1060px;display:flex;flex-direction:column;justify-content:center;gap:22px">
      <span class="label" style="font-size:17px">Leak detection &amp; DMCA takedowns for creators</span>
      <div style="font-weight:800;font-size:78px;line-height:1.02;letter-spacing:-.045em">Leaked today.<br><span style="color:${C.rose}">Gone tomorrow.</span></div>
      <span class="url" style="font-size:20px">www.sentryvo.com &nbsp;·&nbsp; Run your free scan</span>
    </div>`);
  await shot('facebook-cover-1640x624.png', 1640, 624, fbCover);

  // ---------- Instagram story highlight covers 1080x1920 ----------
  // Instagram shows only a circle from the middle, so one big icon in the centre.
  const icon = {
    how: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
    pricing: '<path d="M20 12l-8 8-8-8V4h8z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    results: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    faq: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6"/>',
  };
  for (const key of ['how', 'pricing', 'results', 'faq']) {
    await shot(`instagram-highlight-${key}.png`, 1080, 1920, page(1080, 1920, `
      <div style="position:absolute;left:0;right:0;top:0;bottom:0;display:grid;place-items:center">
        <div style="width:420px;height:420px;border-radius:50%;background:rgba(255,90,157,.12);display:grid;place-items:center;border:4px solid rgba(255,90,157,.5)">
          <svg viewBox="0 0 24 24" width="220" height="220" fill="none" stroke="${C.ink}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon[key]}</svg>
        </div>
      </div>`));
  }

  // ---------- Telegram channel welcome post 1280x720 ----------
  // Telegram channels have no cover image; pin this as the first post instead.
  const tgWelcome = page(1280, 720, `
    <div style="position:absolute;right:-120px;top:-80px">${radar(880)}</div>
    <div style="position:absolute;left:90px;top:0;bottom:0;width:700px;display:flex;flex-direction:column;justify-content:center;gap:24px">
      <div style="width:84px;height:84px">${mark(C.ink, C.rose)}</div>
      <span class="label">Welcome to SentryVo</span>
      <div style="font-weight:800;font-size:66px;line-height:1.02;letter-spacing:-.045em">Leaked today.<br><span style="color:${C.rose}">Gone tomorrow.</span></div>
      <div style="font:400 22px/1.45 'Martian Mono',monospace;color:rgba(239,234,247,.75)">We find leaked creator content and<br>send the DMCA takedowns for you.</div>
      <span class="url">www.sentryvo.com &nbsp;·&nbsp; Free scan</span>
    </div>`);
  await shot('telegram-welcome-1280x720.png', 1280, 720, tgWelcome);

  await b.close();
})();
