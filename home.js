// ---------------- Homepage animations ----------------
// Radar hero, rotating platform name, search clean-up demo, 72-hour case
// file, before/after slider, odometers, price switch and scroll reveals.
// The real free scan and FAQ logic stay in script.js.
(() => {
  document.documentElement.classList.add('js');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasIO = 'IntersectionObserver' in window;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Sticky header gets a hairline once the page scrolls
  const header = document.querySelector('.site-header');
  const onScroll = () => header && header.classList.toggle('scrolled', scrollY > 10);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Seamless marquees: duplicate their content once
  ['h-ticker', 'h-bigmq'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.insertAdjacentHTML('beforeend', el.innerHTML);
    [...el.children].slice(el.children.length / 2).forEach((c) => c.setAttribute('aria-hidden', 'true'));
  });

  // Rotating platform name in the hero
  const rot = [...document.querySelectorAll('#h-rot span')];
  let ri = 0;
  if (rot.length && !reduce) {
    setInterval(() => {
      const cur = rot[ri];
      ri = (ri + 1) % rot.length;
      const nx = rot[ri];
      cur.classList.remove('on');
      cur.classList.add('out');
      nx.classList.remove('out');
      nx.classList.add('on');
      setTimeout(() => cur.classList.remove('out'), 650);
    }, 2200);
  }

  // ---------------- Radar ----------------
  const RADAR = { found: '#FF5A9D', sent: '#F2A33A', removed: '#2FCFB4', signal: '#FF5A9D' };
  const hexA = (hex, a) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const rc = document.getElementById('h-radar');
  if (rc) {
    const rx = rc.getContext('2d');
    let RS = 0;
    let running = true;
    let sweep = -Math.PI / 2;
    let last = performance.now();
    const blips = [
      { a: 0.6, r: 0.72, s: 'found', t: 'reddit.com' },
      { a: 1.7, r: 0.48, s: 'sent', t: 't.me' },
      { a: 2.6, r: 0.82, s: 'removed', t: 'pirate-tube.xyz' },
      { a: 3.5, r: 0.36, s: 'found', t: 'google images' },
      { a: 4.3, r: 0.64, s: 'sent', t: 'leakhub.cc' },
      { a: 5.3, r: 0.55, s: 'removed', t: 'x.com' },
      { a: 5.85, r: 0.88, s: 'found', t: 'forum.vip' },
    ].map((b) => ({ ...b, glow: 0 }));
    const nextS = { found: 'sent', sent: 'removed', removed: 'found' };
    const labels = { found: 'Leak found', sent: 'DMCA sent', removed: 'Removed' };
    const rows = [...document.querySelectorAll('#h-feed .h-feed-row')];
    const actEl = document.getElementById('h-actions');
    let actions = 1006;
    const norm = (v) => ((v % 6.283) + 6.283) % 6.283;
    const crossed = (p, n, a) => {
      const pn = norm(p), nn = norm(n), an = norm(a);
      return pn <= nn ? an > pn && an <= nn : an > pn || an <= nn;
    };
    const size = () => {
      const d = Math.min(devicePixelRatio || 1, 2);
      RS = rc.clientWidth;
      rc.width = RS * d;
      rc.height = RS * d;
      rx.setTransform(d, 0, 0, d, 0, 0);
    };
    const flash = (i) => {
      const row = rows[i];
      if (!row) return;
      row.dataset.s = blips[i].s;
      row.querySelector('.h-badge').textContent = labels[blips[i].s];
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    };
    const draw = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      const c = RS / 2, R = c - 6;
      rx.clearRect(0, 0, RS, RS);
      rx.strokeStyle = 'rgba(239,234,247,.12)';
      rx.lineWidth = 1;
      [1, 0.75, 0.5, 0.25].forEach((k) => { rx.beginPath(); rx.arc(c, c, R * k, 0, 6.283); rx.stroke(); });
      rx.beginPath(); rx.moveTo(c - R, c); rx.lineTo(c + R, c); rx.moveTo(c, c - R); rx.lineTo(c, c + R); rx.stroke();
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * 6.283, l = i % 6 ? 4 : 9;
        rx.beginPath();
        rx.moveTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
        rx.lineTo(c + Math.cos(a) * (R - l), c + Math.sin(a) * (R - l));
        rx.stroke();
      }
      const prev = sweep;
      if (!reduce) sweep += dt * 0.0016;
      for (let i = 0; i < 40; i++) {
        const a1 = sweep - 1.1 * (i / 40), a0 = sweep - 1.1 * ((i + 1) / 40);
        rx.beginPath(); rx.moveTo(c, c); rx.arc(c, c, R, a0, a1); rx.closePath();
        rx.fillStyle = hexA(RADAR.signal, 0.22 * (1 - i / 40));
        rx.fill();
      }
      rx.strokeStyle = hexA(RADAR.signal, 0.9);
      rx.lineWidth = 2;
      rx.beginPath(); rx.moveTo(c, c); rx.lineTo(c + Math.cos(sweep) * R, c + Math.sin(sweep) * R); rx.stroke();
      rx.font = '500 10px "Martian Mono", monospace';
      blips.forEach((b, i) => {
        const ang = b.a - Math.PI / 2;
        if (crossed(prev, sweep, ang)) {
          b.glow = 1;
          b.s = nextS[b.s];
          flash(i);
          actions += 1 + ((Math.random() * 3) | 0);
          if (actEl) actEl.textContent = actions.toLocaleString('en-US');
        }
        b.glow = Math.max(0.25, b.glow - dt * 0.0005);
        const x = c + Math.cos(ang) * R * b.r, y = c + Math.sin(ang) * R * b.r, col = RADAR[b.s];
        rx.fillStyle = hexA(col, 0.18 * b.glow); rx.beginPath(); rx.arc(x, y, 14 * b.glow + 4, 0, 6.283); rx.fill();
        rx.fillStyle = hexA(col, 0.4 + 0.6 * b.glow); rx.beginPath(); rx.arc(x, y, 3.5, 0, 6.283); rx.fill();
        if (RS > 280) { rx.fillStyle = `rgba(239,234,247,${0.25 + 0.55 * b.glow})`; rx.fillText(b.t, x + 9, y + 3); }
      });
      rx.fillStyle = RADAR.signal; rx.beginPath(); rx.arc(c, c, 4, 0, 6.283); rx.fill();
      if (running && !reduce) requestAnimationFrame(draw);
    };
    size();
    addEventListener('resize', size);
    requestAnimationFrame(draw);
    // Pause the radar while it's off screen, so it doesn't drain phone batteries
    if (hasIO && !reduce) {
      new IntersectionObserver((es) => {
        const vis = es[0].isIntersecting;
        if (vis && !running) { running = true; last = performance.now(); requestAnimationFrame(draw); }
        running = vis;
      }).observe(rc);
    }
  }

  // ---------------- Search clean-up demo ----------------
  const qEl = document.getElementById('h-q'), resEl = document.getElementById('h-results'), leftCount = document.getElementById('h-left');
  if (resEl) {
    const DATA = [
      { t: 'astro_domina | OnlyFans', u: 'onlyfans.com/astro_domina', own: true },
      { t: 'astro_domina full leak pack (free download)', u: 'pirate-tube.xyz/leaks/astro-domina-full' },
      { t: 'astro_domina leaked | Telegram channel', u: 't.me/leaked_creators/4829' },
      { t: 'r/leaks: astro_domina new set', u: 'reddit.com/r/leaks/astro_domina' },
      { t: 'astro_domina gallery – 214 photos', u: 'leakhub.cc/astro_domina/gallery' },
    ];
    const render = () => {
      resEl.innerHTML = DATA.map((d) => `<div class="h-res${d.own ? ' own' : ''}"><span class="t">${esc(d.t)}</span><span class="h-badge" data-s="${d.own ? 'removed' : 'found'}">${d.own ? 'Your page' : 'Leak found'}</span><span class="u">${esc(d.u)}</span><span class="h-stamp">Removed</span></div>`).join('');
    };
    const loop = async () => {
      for (;;) {
        render();
        leftCount.textContent = '4';
        qEl.textContent = '';
        const rs = [...resEl.children];
        rs.forEach((r) => (r.style.opacity = 0));
        for (const ch of '"astro_domina" leaked') { qEl.textContent += ch; await wait(55); }
        for (const r of rs) { r.style.opacity = 1; await wait(130); }
        if (reduce) return;
        await wait(900);
        let left = 4;
        for (const r of rs.slice(1)) {
          const b = r.querySelector('.h-badge');
          r.classList.add('hl'); await wait(500);
          b.dataset.s = 'sent'; b.textContent = 'DMCA sent'; await wait(700);
          r.classList.add('struck'); await wait(450);
          b.dataset.s = 'removed'; b.textContent = 'Removed'; r.classList.add('stamped'); await wait(800);
          r.classList.add('gone'); leftCount.textContent = --left; await wait(500);
        }
        await wait(2600);
      }
    };
    render();
    if (hasIO) {
      const lio = new IntersectionObserver((es) => { if (es[0].isIntersecting) { lio.disconnect(); loop(); } }, { threshold: 0.3 });
      lio.observe(resEl);
    } else loop();
  }

  // ---------------- 72-hour case file ----------------
  const evs = [...document.querySelectorAll('.h-ev')];
  const hr = document.getElementById('h-hr'), trk = document.getElementById('h-trk'), chip = document.getElementById('h-chip'), cdesc = document.getElementById('h-cdesc');
  if (evs.length && hr && hasIO) {
    let shownH = 0, animH;
    const setEvent = (ev) => {
      evs.forEach((e) => e.classList.toggle('on', e === ev));
      const target = +ev.dataset.h;
      chip.dataset.s = ev.dataset.c;
      chip.textContent = ev.dataset.l;
      cdesc.textContent = ev.querySelector('p').textContent;
      trk.style.width = (target / 72) * 100 + '%';
      cancelAnimationFrame(animH);
      const from = shownH, t0 = performance.now();
      const step = (t) => {
        const k = reduce ? 1 : Math.min(1, (t - t0) / 700);
        shownH = Math.round(from + (target - from) * k);
        hr.textContent = String(shownH).padStart(2, '0');
        if (k < 1) animH = requestAnimationFrame(step);
      };
      animH = requestAnimationFrame(step);
    };
    const eio = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) setEvent(en.target); }), { rootMargin: '-45% 0px -45% 0px' });
    evs.forEach((e) => eio.observe(e));
  }

  // ---------------- Before / after slider ----------------
  const box = document.getElementById('h-compare'), cmp = document.getElementById('h-cmp');
  if (box && cmp) {
    const setPos = (v) => box.style.setProperty('--pos', v + '%');
    let touched = false;
    cmp.addEventListener('input', () => { touched = true; setPos(cmp.value); });
    if (!reduce && hasIO) {
      const cio = new IntersectionObserver((es) => {
        if (!es[0].isIntersecting) return;
        cio.disconnect();
        const t0 = performance.now();
        const sw = (t) => {
          if (touched) return;
          const k = (t - t0) / 2600;
          if (k >= 1) { setPos(50); cmp.value = 50; return; }
          const v = 50 + Math.sin(k * Math.PI * 2) * 30;
          setPos(v);
          cmp.value = v;
          requestAnimationFrame(sw);
        };
        requestAnimationFrame(sw);
      }, { threshold: 0.6 });
      cio.observe(box);
    }
  }

  // ---------------- Odometers ----------------
  const buildOdo = (el, n) => {
    el.innerHTML = String(n).split('').map(() => `<span class="col">${'0123456789'.split('').map((d) => `<span>${d}</span>`).join('')}</span>`).join('');
  };
  const rollOdo = (el, n) => {
    const s = String(n);
    if (el.children.length !== s.length) buildOdo(el, n);
    requestAnimationFrame(() => [...el.children].forEach((col, i) => { col.style.transform = `translateY(-${+s[i]}em)`; }));
  };
  const statOdos = [...document.querySelectorAll('#h-odos .h-odo')];
  statOdos.forEach((o) => buildOdo(o, o.dataset.n));
  let rolled = false;
  const rollStats = () => {
    if (rolled) return;
    rolled = true;
    statOdos.forEach((o, i) => setTimeout(() => rollOdo(o, o.dataset.n), reduce ? 0 : i * 150));
  };
  if (hasIO && !reduce && statOdos.length) {
    const oio = new IntersectionObserver((es) => { if (es[0].isIntersecting) { rollStats(); oio.disconnect(); } }, { threshold: 0.5 });
    oio.observe(document.getElementById('h-odos'));
    setTimeout(rollStats, 7000); // never leave the numbers at zero
  } else rollStats();

  // Price switch: first month vs. month 2 onwards
  const priceOdos = [...document.querySelectorAll('[data-price]')], pers = [...document.querySelectorAll('[data-per]')];
  const pFirst = document.getElementById('h-p-first'), pThen = document.getElementById('h-p-then');
  const showPrice = (first) => {
    priceOdos.forEach((o) => rollOdo(o, first ? o.dataset.a : o.dataset.b));
    pers.forEach((p) => (p.textContent = first ? 'first month' : 'per month'));
    pFirst.setAttribute('aria-pressed', first);
    pThen.setAttribute('aria-pressed', !first);
  };
  if (pFirst && pThen) {
    showPrice(true);
    pFirst.addEventListener('click', () => showPrice(true));
    pThen.addEventListener('click', () => showPrice(false));
  }

  // Ticket notches sit on the dashed tear line
  const placeCuts = () => document.querySelectorAll('.h-ticket').forEach((t) => t.style.setProperty('--cut', t.querySelector('.h-perf').offsetTop + 'px'));
  placeCuts();
  addEventListener('resize', placeCuts);
  if (document.fonts) document.fonts.ready.then(placeCuts);

  // ---------------- Reveal on scroll ----------------
  const rvs = [...document.querySelectorAll('.rv')];
  if (hasIO && !reduce) {
    const io = new IntersectionObserver((es) => es.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.remove('pending'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -6% 0px' });
    rvs.forEach((el, i) => {
      if (el.getBoundingClientRect().top > innerHeight) {
        el.classList.add('pending');
        el.style.transitionDelay = (i % 3) * 70 + 'ms';
        io.observe(el);
      }
    });
    setTimeout(() => rvs.forEach((el) => el.classList.remove('pending')), 6000);
  }
})();
