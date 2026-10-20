// Records demo video 3, "How to buy a SentryVo plan", from the real site pages.
//
// The site is served from this repo at its real address (www.sentryvo.com is
// routed to local files) and every backend call is answered with made-up
// example data, so no account, payment or email is ever created. The hosted
// checkout is replaced by checkout-demo.html.
//
// Time is virtual: page timers and requestAnimationFrame run on Playwright's
// fake clock and every CSS animation is paused and stepped to the same clock,
// so the result is a smooth 30 fps video however slow the capture is.
//
// usage: node record-purchase.js <outdir> vertical|landscape
// writes <outdir>/f00000.jpg ... and <outdir>/events.json (scene/click times for the music)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const [OUT, LAYOUT = 'landscape'] = process.argv.slice(2);
const VERT = LAYOUT === 'vertical';
const VIEW = VERT ? { width: 432, height: 768, dsf: 2.5 } : { width: 1280, height: 720, dsf: 1.5 };
const FPS = 30;
const SITE = 'https://www.sentryvo.com';
const START = new Date('2026-10-20T10:00:00');

// ---------- made-up example customer ----------
const DEMO = {
  name: 'Luna Demo',
  email: 'luna.demo@example.com',
  mobile: '+1 555 010 2030',
  password: 'DemoPass2026!',
  aliases: 'lunademo, luna_demo',
  links: 'https://onlyfans.com/lunademo\nhttps://fansly.com/lunademo',
};
const ago = (h) => new Date(START.getTime() - h * 3600e3).toISOString();
const LEAKS = [
  ['serper_image', 'https://img-leakvault.example/lunademo/set-14.jpg', 'removed', 1],
  ['serper', 'https://freefanspics.example/creators/lunademo-onlyfans', 'removed', 4],
  ['serper', 'https://t.me/s/luna_demo_free', 'reported', 9],
  ['serper_lens', 'https://pixdump.example/a/8f2k1', 'removed', 20],
  ['serper', 'https://leakzone.example/thread/lunademo-mega', 'reported', 27],
  ['serper_image', 'https://cdn.picshare.example/u/luna_demo_02.jpg', 'removed', 33],
  ['serper', 'https://tubeclips.example/v/luna-demo-video', 'removed', 50],
  ['serper', 'https://forum.fanleaks.example/t/lunademo', 'reported', 58],
  ['serper_lens', 'https://imgmirror.example/i/77ad3', 'removed', 75],
  ['serper', 'https://reddit.com/r/example/comments/lunademo', 'manual_review', 98],
  ['serper', 'https://leaksite.example/lunademo-onlyfans-free', 'reported', 118],
  ['serper_image', 'https://thumbs.example/luna_demo_set3.jpg', 'found', 140],
].map(([source, url, status, h]) => ({ source, url, status, found_at: ago(h) }));
const SUMMARY = {
  name: DEMO.name, email: DEMO.email, plan: 'multi', status: 'active',
  platforms: ['OnlyFans', 'Fansly'], aliases: ['lunademo', 'luna_demo'],
  originalLinks: DEMO.links.split('\n'), reportFrequencyDays: 1, lastReportAt: ago(3),
  summary: { total: LEAKS.length, reported: LEAKS.filter((l) => l.status === 'reported').length, removed: LEAKS.filter((l) => l.status === 'removed').length },
};

// ---------- overlay drawn inside the page (cursor, step captions, title cards) ----------
const OVERLAY = `(() => {
  const VERT = ${VERT};
  function build() {
    if (document.getElementById('__demo')) return;
    const host = document.createElement('div');
    host.id = '__demo';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(host);
    const r = host.attachShadow({ mode: 'open' });
    r.innerHTML = \`<style>
      *{box-sizing:border-box;margin:0}
      .cap{position:absolute;left:50%;\${VERT ? 'bottom:150px' : 'bottom:26px'};transform:translateX(-50%);width:max-content;max-width:\${VERT ? '400px' : '900px'};
        display:flex;align-items:center;gap:\${VERT ? 10 : 14}px;background:rgba(26,21,48,.94);color:#EFEAF7;border-radius:999px;
        padding:\${VERT ? '9px 16px 9px 9px' : '11px 24px 11px 11px'};box-shadow:0 18px 40px -14px rgba(26,21,48,.55);border:1px solid rgba(239,234,247,.12)}
      .num{flex:none;width:\${VERT ? 34 : 40}px;height:\${VERT ? 34 : 40}px;border-radius:50%;background:#D82F74;color:#fff;display:grid;place-items:center;
        font:700 \${VERT ? 14 : 16}px Unbounded,'Arial Black',sans-serif}
      .txt{font:600 \${VERT ? 14.5 : 19}px/1.25 'Instrument Sans',system-ui,sans-serif;white-space:normal}
      .dots{position:absolute;left:50%;\${VERT ? 'bottom:134px' : 'bottom:8px'};transform:translateX(-50%);display:flex;gap:6px}
      .dots i{display:block;width:6px;height:6px;border-radius:3px;background:rgba(26,21,48,.25)}
      .dots i.on{width:18px;background:#D82F74}
      .cur{position:absolute;left:0;top:0;width:0;height:0}
      .arrow{position:absolute;left:-3px;top:-2px;width:26px;height:26px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.35))}
      .touch{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:rgba(26,21,48,.28);border:2.5px solid rgba(255,255,255,.95);box-shadow:0 4px 12px rgba(0,0,0,.25)}
      .ring{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:3px solid #D82F74}
      .card{position:absolute;inset:0;background:#1A1530;color:#EFEAF7;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;
        background-image:radial-gradient(circle at 50% 42%, rgba(216,47,116,.22), transparent 55%)}
      .card .k{font:500 \${VERT ? 11 : 13}px 'Martian Mono',monospace;letter-spacing:.14em;text-transform:uppercase;color:#FF5A9D;margin-bottom:18px}
      .card h1{font:700 \${VERT ? 30 : 50}px/1.08 Unbounded,'Arial Black',sans-serif;letter-spacing:-.02em;max-width:14ch}
      .card p{font:500 \${VERT ? 16 : 21}px/1.4 'Instrument Sans',sans-serif;color:#C9C1DE;margin-top:18px;max-width:30ch}
      .card .s{font:500 \${VERT ? 10.5 : 12}px 'Martian Mono',monospace;color:#857E9E;margin-top:26px;letter-spacing:.06em}
      .card .logo{width:\${VERT ? 84 : 110}px;height:\${VERT ? 84 : 110}px;margin-bottom:22px;color:#EFEAF7}
      .card .url{margin-top:24px;font:600 \${VERT ? 15 : 20}px 'Martian Mono',monospace;background:#D82F74;color:#fff;border-radius:999px;padding:12px 24px}
    </style><div class="cap"><div class="num"></div><div class="txt"></div></div><div class="dots"></div>
      <div class="cur"><svg class="arrow" viewBox="0 0 24 24"><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L17.5 13.4 Z" fill="#fff" stroke="#1A1530" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="touch"></div><div class="ring"></div></div>
      <div class="card"></div>\`;
    window.__demoRoot = r;
  }
  const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3));
  window.__demoSet = (s) => {
    build();
    const r = window.__demoRoot;
    const cap = r.querySelector('.cap');
    const k = ease(s.capT / 0.45);
    cap.style.display = s.step ? 'flex' : 'none';
    cap.style.opacity = k;
    cap.style.transform = 'translateX(-50%) translateY(' + ((1 - k) * 14) + 'px) scale(' + (0.94 + 0.06 * k) + ')';
    r.querySelector('.num').textContent = s.step || '';
    r.querySelector('.txt').textContent = s.text || '';
    const dots = r.querySelector('.dots');
    dots.style.display = s.step ? 'flex' : 'none';
    dots.innerHTML = Array.from({ length: s.total }, (_, i) => '<i class="' + (i + 1 === s.step ? 'on' : '') + '"></i>').join('');
    const cur = r.querySelector('.cur');
    cur.style.display = s.cursor.show ? 'block' : 'none';
    cur.style.transform = 'translate(' + s.cursor.x + 'px,' + s.cursor.y + 'px)';
    r.querySelector('.arrow').style.display = VERT ? 'none' : 'block';
    const press = s.cursor.clickT >= 0 && s.cursor.clickT < 0.12;
    r.querySelector('.touch').style.display = VERT ? 'block' : 'none';
    r.querySelector('.touch').style.transform = press ? 'scale(.8)' : 'scale(1)';
    r.querySelector('.arrow').style.transform = press ? 'scale(.88)' : 'scale(1)';
    const ring = r.querySelector('.ring');
    const rt = s.cursor.clickT / 0.5;
    ring.style.display = s.cursor.clickT >= 0 && rt < 1 ? 'block' : 'none';
    ring.style.opacity = 1 - rt;
    ring.style.transform = 'scale(' + (0.4 + 1.2 * ease(rt)) + ')';
    const card = r.querySelector('.card');
    card.style.display = s.card.opacity > 0.001 ? 'flex' : 'none';
    card.style.opacity = s.card.opacity;
    if (card.dataset.key !== s.card.key) { card.innerHTML = s.card.html || ''; card.dataset.key = s.card.key; }
    const inner = card.children;
    for (let i = 0; i < inner.length; i++) {
      const t = ease((s.card.t - 0.15 - i * 0.12) / 0.5);
      inner[i].style.opacity = t;
      inner[i].style.transform = 'translateY(' + (1 - t) * 18 + 'px)';
    }
  };
})();`;

const LOGO = '<svg class="logo" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" stroke-width="4.5"/><circle cx="32" cy="32" r="14.5" fill="none" stroke="currentColor" stroke-width="4" opacity=".35"/><path d="M32 32 L32 6 A26 26 0 0 1 54.5 19 Z" fill="#FF5A9D"/><circle cx="46" cy="42" r="3.2" fill="currentColor"/><circle cx="32" cy="32" r="5" fill="#FF5A9D"/></svg>';
const CARDS = {
  intro: `<div class="k">SentryVo · step by step</div><h1>How to get protected</h1><p>Sign up and start your protection in about two minutes.</p><div class="s">Demo with example details</div>`,
  later: `<div class="k">Meanwhile, SentryVo gets to work</div><h1>A few days later…</h1><p>Your stage names are scanned every 6 hours and takedowns go out automatically.</p>`,
  outro: `${LOGO}<h1>Protect your content today</h1><p>Plans from $30 for your first month. Cancel anytime.</p><div class="url">www.sentryvo.com</div>`,
};
const TOTAL_STEPS = 7;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: VIEW.width, height: VIEW.height },
    deviceScaleFactor: VIEW.dsf,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });

  // ---------- network: real site files, fake backend ----------
  const cors = { 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  const json = (route, body) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'www.sentryvo.com') {
      let p = decodeURIComponent(u.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ path: file });
    }
    if (u.hostname === 'shop.sentryvo.com') return route.fulfill({ path: path.join(__dirname, 'checkout-demo.html') });
    if (u.hostname === 'api.sentryvo.com') {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname === '/api/register') return json(route, { checkoutUrl: 'https://shop.sentryvo.com/checkout/buy/sentryvo-multiple' });
      if (u.pathname === '/api/login') return json(route, { role: 'creator' });
      if (u.pathname === '/api/dashboard/summary') return json(route, SUMMARY);
      if (u.pathname === '/api/dashboard/leaks') return json(route, { leaks: LEAKS });
      return json(route, {});
    }
    if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return route.continue();
    return route.abort(); // analytics, affiliate script, anything else
  });

  const page = await context.newPage();
  await page.addInitScript(OVERLAY);
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START);

  // ---------- state + frame capture ----------
  let frame = 0;
  const events = [];
  const st = { step: 0, text: '', capFrame: 0, cursor: { x: VIEW.width * 0.6, y: VIEW.height * 0.6, show: false, clickFrame: -999 }, card: { key: '', html: '', opacity: 0, frame: 0 } };
  const ev = (type, extra = {}) => events.push({ type, t: +(frame / FPS).toFixed(3), ...extra });

  async function syncPage() {
    await page.evaluate((s) => {
      // step every CSS animation/transition to the fake clock
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (a.__v === undefined) { a.__v = now - (a.currentTime || 0); a.pause(); }
        a.currentTime = now - a.__v;
      }
      window.__demoSet(s);
    }, {
      step: st.step, total: TOTAL_STEPS, text: st.text, capT: (frame - st.capFrame) / FPS,
      cursor: { x: st.cursor.x, y: st.cursor.y, show: st.cursor.show, clickT: (frame - st.cursor.clickFrame) / FPS },
      card: { key: st.card.key, html: st.card.html, opacity: st.card.opacity, t: (frame - st.card.frame) / FPS },
    });
  }
  async function shot() {
    for (let tries = 0; ; tries++) {
      try { await syncPage(); break; } catch (e) {
        // a click just started a navigation: wait for the new page, then draw
        if (tries > 20) throw e;
        await page.waitForLoadState('load').catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    await page.screenshot({ path: path.join(OUT, `f${String(frame).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
    frame++;
    await page.clock.runFor(Math.round((frame * 1000) / FPS) - Math.round(((frame - 1) * 1000) / FPS));
  }
  async function hold(sec, each) {
    const n = Math.round(sec * FPS);
    for (let i = 0; i < n; i++) { if (each) await each(i / n, i); await shot(); }
  }
  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function caption(step, text) { st.step = step; st.text = text; st.capFrame = frame; ev('step', { step }); }
  function card(key) { st.card.key = key; st.card.html = CARDS[key]; st.card.frame = frame; }
  async function fadeCard(to, sec) { const from = st.card.opacity; await hold(sec, (k) => { st.card.opacity = from + (to - from) * easeIO(k); }); st.card.opacity = to; }

  async function moveTo(x, y, sec = 0.6) {
    const { x: x0, y: y0 } = st.cursor;
    st.cursor.show = true;
    await hold(sec, (k) => { const e = easeIO(k); st.cursor.x = x0 + (x - x0) * e; st.cursor.y = y0 + (y - y0) * e; });
    st.cursor.x = x; st.cursor.y = y;
  }
  async function box(sel) {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error('not visible: ' + sel);
    return b;
  }
  async function scrollBy(dy, sec = 0.8) {
    const y0 = await page.evaluate(() => window.scrollY);
    await hold(sec, (k) => page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y0 + dy * easeIO(k)));
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y0 + dy);
  }
  // scroll so the element's top sits at `frac` of the viewport height
  async function scrollToEl(sel, frac = 0.3, sec = 0.8) {
    const b = await box(sel);
    await scrollBy(b.y - VIEW.height * frac, sec);
  }
  async function tap(sel, { sec = 0.55, after = 0.25, dx = 0.5 } = {}) {
    const b = await box(sel);
    const x = b.x + Math.min(b.width * dx, VERT ? b.width / 2 : 60 + b.width * 0.15);
    const y = b.y + b.height / 2;
    await moveTo(x, y, sec);
    st.cursor.clickFrame = frame;
    ev('click');
    await shot();
    await page.mouse.click(x, y);
    await hold(after);
  }
  async function type(sel, text, cps = 22) {
    await tap(sel, { after: 0.1 });
    const perFrame = cps / FPS;
    let done = 0, acc = 0;
    while (done < text.length) {
      acc += perFrame;
      const n = Math.max(0, Math.floor(acc) - done);
      if (n) {
        const chunk = text.slice(done, done + n);
        for (const ch of chunk) { if (ch === '\n') await page.keyboard.press('Enter'); else await page.keyboard.insertText(ch); }
        done += n;
        ev('key');
      }
      await shot();
    }
    await hold(0.2);
  }
  async function goto(url) {
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
  }
  // follow a navigation started by a click, keeping the last frame on screen meanwhile
  async function waitNav(urlPart) {
    await page.waitForURL((u) => u.href.includes(urlPart), { timeout: 15000 });
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    ev('page', { url: urlPart });
  }

  // =================== the story ===================
  await goto(SITE + '/');
  card('intro'); st.card.opacity = 1;
  ev('intro');
  await hold(2.6);
  await fadeCard(0, 0.5);

  // 1 — home page, scroll to pricing, pick Multiple
  caption(1, 'Go to sentryvo.com and choose a plan');
  await hold(1.4);
  await scrollToEl('.h-tickets', VERT ? 0.12 : 0.1, 1.6);
  await hold(0.5);
  if (VERT) await scrollToEl('.h-ticket.best .btn', 0.62, 0.8);
  await tap('.h-ticket.best .btn', { after: 0.1 });
  await waitNav('register.html');

  // 2 — platforms
  caption(2, 'Tick the platforms you post on');
  st.cursor.show = !VERT;
  await hold(0.6);
  await scrollToEl('#multi-platform-field', VERT ? 0.36 : 0.32, 0.8);
  await tap('#multi-platform-field label.chip:nth-of-type(1)');
  await tap('#multi-platform-field label.chip:nth-of-type(2)');
  await hold(0.3);

  // 3 — account details
  caption(3, 'Add your name, email and a password');
  await scrollToEl('#full-name', VERT ? 0.3 : 0.25, 0.7);
  await type('#full-name', DEMO.name);
  await type('#email', DEMO.email, 30);
  if (VERT) await scrollToEl('#mobile', 0.3, 0.5);
  await type('#mobile', DEMO.mobile, 26);
  await type('#password', DEMO.password, 30);

  // 4 — what to watch
  caption(4, 'Add the stage names to watch and links to your own pages');
  await scrollToEl('#aliases', VERT ? 0.24 : 0.2, 0.8);
  await type('#aliases', DEMO.aliases);
  await type('#original-links', DEMO.links, 34);
  await hold(0.3);
  await scrollToEl('#checkout-submit', VERT ? 0.5 : 0.55, 0.7);
  await tap('#checkout-submit', { after: 0.4 });
  await waitNav('shop.sentryvo.com');

  // 5 — checkout
  caption(5, 'Pay securely by card');
  await page.evaluate((e) => window.demo.fill('f-email', e), DEMO.email);
  await hold(0.6);
  const fill = async (id, text, cps = 20) => {
    const b = await box('#' + id);
    await moveTo(b.x + Math.min(70, b.width / 2), b.y + b.height / 2, 0.45);
    st.cursor.clickFrame = frame; ev('click');
    await page.evaluate((i) => window.demo.focus(i), id);
    let n = 0;
    await hold(text.length / cps, async (k) => {
      const m = Math.ceil(k * text.length);
      if (m !== n) { n = m; ev('key'); await page.evaluate(([i, t]) => window.demo.fill(i, t), [id, text.slice(0, n)]); }
    });
    await page.evaluate(([i, t]) => window.demo.fill(i, t), [id, text]);
    await hold(0.15);
  };
  await fill('f-card', '4242 4242 4242 4242', 26);
  await fill('f-exp', '12 / 28', 14);
  await fill('f-cvc', '123', 10);
  await fill('f-name', DEMO.name, 18);
  await page.evaluate(() => window.demo.focus(''));
  if (VERT) await scrollToEl('#pay', 0.6, 0.6);
  await tap('#pay', { after: 0 });
  await page.evaluate(() => window.demo.pay('busy'));
  await hold(1.0);
  await page.evaluate(() => window.demo.pay('done'));
  ev('paid');
  await hold(0.9);
  await goto(SITE + '/success.html');
  ev('page', { url: 'success' });

  // 6 — success
  caption(6, 'Done. Your account is active and scanning starts');
  st.cursor.show = !VERT;
  await hold(2.4);

  // time skip
  card('later');
  await fadeCard(1, 0.5);
  ev('later');
  await hold(2.0);
  await goto(SITE + '/login.html');
  await fadeCard(0, 0.5);

  // 7 — login + dashboard
  caption(7, 'Log in to watch leaks get found and removed');
  await type('#login-email', DEMO.email, 34);
  await type('#login-password', DEMO.password, 34);
  await tap('#login-submit', { after: 0.1 });
  await waitNav('dashboard.html');
  await hold(1.6);
  await scrollToEl('#activity-rows', VERT ? 0.2 : 0.18, 1.4);
  await hold(1.6);
  await scrollBy(VERT ? 380 : 260, 1.4);
  await hold(1.2);
  await scrollBy(-99999, 0.8);
  // on phones the dashboard tabs are a sideways strip: bring Takedowns into view first
  await page.locator('.dash-link[data-tab="takedowns"]').evaluate((e) => e.scrollIntoView({ block: 'nearest', inline: 'center' }));
  await tap('.dash-link[data-tab="takedowns"]', { after: 1.8 });

  // outro
  st.step = 0; st.cursor.show = false;
  card('outro');
  ev('outro');
  await fadeCard(1, 0.5);
  await hold(3.4);

  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify({ duration: frame / FPS, events }, null, 1));
  console.log(`${frame} frames, ${(frame / FPS).toFixed(1)} s`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
