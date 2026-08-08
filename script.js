document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav toggle
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(i => i !== item && i.classList.remove('open'));
      item.classList.toggle('open', !isOpen);
    });
  });

  initScanDemo();
  initRegisterForm();
  initFreeScan();
});

// ---------------- Registration + Lemon Squeezy checkout flow ----------------
// Point this at your deployed backend (see /server/README.md).
// Use http://localhost:4242 while testing locally.
const SENTRYVO_BACKEND_URL = 'https://your-sentryvo-backend.example.com';

function initRegisterForm() {
  const form = document.getElementById('order-form');
  if (!form) return;

  const statusEl = document.getElementById('checkout-status');
  const submitBtn = document.getElementById('checkout-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const plan = form.querySelector('#plan-select').value; // 'single' | 'multi'
    const name = form.querySelector('#full-name').value.trim();
    const email = form.querySelector('#email').value.trim();
    const mobile = form.querySelector('#mobile').value.trim();
    const password = form.querySelector('#password').value;
    const aliasesRaw = form.querySelector('#aliases')?.value.trim() || '';
    const aliases = aliasesRaw ? aliasesRaw.split(',').map((a) => a.trim()).filter(Boolean) : [name];
    const originalLinksRaw = form.querySelector('#original-links')?.value.trim() || '';
    const originalLinks = originalLinksRaw ? originalLinksRaw.split('\n').map((l) => l.trim()).filter(Boolean) : [];

    let platforms = [];
    if (plan === 'single') {
      const selected = form.querySelector('#platform-single').value;
      if (selected === 'Other') {
        const otherName = form.querySelector('#single-other-name')?.value.trim();
        const otherLink = form.querySelector('#single-other-link')?.value.trim();
        if (!otherName) {
          if (statusEl) { statusEl.textContent = 'Enter the name of your platform.'; statusEl.style.color = '#0096F5'; }
          return;
        }
        platforms = [otherName];
        if (otherLink) originalLinks.push(otherLink);
      } else {
        platforms = [selected];
      }
    } else {
      platforms = Array.from(form.querySelectorAll('.platform-checkbox:checked')).map((cb) => cb.value);
      const otherChecked = form.querySelector('#multi-other-checkbox')?.checked;
      if (otherChecked) {
        const otherName = form.querySelector('#multi-other-name')?.value.trim();
        const otherLink = form.querySelector('#multi-other-link')?.value.trim();
        if (!otherName) {
          if (statusEl) { statusEl.textContent = 'Enter the name of your other platform.'; statusEl.style.color = '#0096F5'; }
          return;
        }
        platforms.push(otherName);
        if (otherLink) originalLinks.push(otherLink);
      }
    }

    if (!name || !email || !mobile || !password) return;
    if (!platforms.length) {
      if (statusEl) { statusEl.textContent = 'Select at least one platform.'; statusEl.style.color = '#0096F5'; }
      return;
    }
    if (plan === 'multi' && platforms.length < 2) {
      if (statusEl) { statusEl.textContent = 'Select 2 or more platforms for the Multi-Platform plan, or switch to Single Platform.'; statusEl.style.color = '#0096F5'; }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';
    if (statusEl) statusEl.textContent = '';

    try {
      const res = await fetch(`${SENTRYVO_BACKEND_URL}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, platforms, name, email, mobile, password, aliases, originalLinks }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Registration could not be started');
      }
      const { checkoutUrl } = await res.json();

      const resultPanel = document.getElementById('order-result');
      if (resultPanel) {
        document.getElementById('ref-code-value').textContent = 'Account created';
        document.getElementById('order-summary').textContent = `${plan === 'multi' ? 'Multi-Platform' : 'Single Platform'} — redirecting to Lemon Squeezy…`;
        resultPanel.classList.remove('hidden');
      }

      // Lemon Squeezy's hosted checkout is a plain redirect — no signed
      // payload needed (unlike the PayFast flow this replaced).
      window.location.href = checkoutUrl;
    } catch (err) {
      console.error('Registration/checkout error:', err);
      if (statusEl) {
        statusEl.textContent = err.message || 'Could not reach the server. Please try again in a moment.';
        statusEl.style.color = '#0096F5';
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue to Checkout';
    }
  });
}

// ---------------- Free scan tool (hero) ----------------
function initFreeScan() {
  const btn = document.getElementById('free-scan-btn');
  const input = document.getElementById('free-scan-input');
  const note = document.getElementById('free-scan-note');
  const resultsBox = document.getElementById('free-scan-results');
  if (!btn || !input || !resultsBox) return;

  async function runScan() {
    const alias = input.value.trim();
    if (alias.length < 2) {
      resultsBox.classList.remove('hidden');
      resultsBox.innerHTML = `<p style="color:#0096F5; font-size:.85rem; margin:0;">Enter a name or username to scan.</p>`;
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Scanning…';
    resultsBox.classList.remove('hidden');
    resultsBox.innerHTML = `<p style="color:var(--text-low); font-size:.85rem; margin:0;">Searching the web for "${escapeHtml(alias)}"…</p>`;

    try {
      const res = await fetch(`${SENTRYVO_BACKEND_URL}/api/scan/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        resultsBox.innerHTML = `<p style="color:#0096F5; font-size:.85rem; margin:0;">${escapeHtml(data.error || 'Scan failed — please try again shortly.')}</p>`;
        return;
      }

      if (!data.results || !data.results.length) {
        resultsBox.innerHTML = `
          <p style="color:var(--teal); font-size:.9rem; margin:0 0 4px;">No obvious leaks found in a quick scan of "${escapeHtml(alias)}".</p>
          <p style="color:var(--text-low); font-size:.78rem; margin:0;">A full subscription scans daily across more sources — sign up for ongoing coverage.</p>`;
        return;
      }

      const rows = data.results
        .map(
          (r) => `
          <div style="padding:10px 0; border-top:1px solid var(--line-soft);">
            <a href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-hi); font-size:.85rem; word-break:break-all;">${escapeHtml(r.title || r.url)}</a>
          </div>`
        )
        .join('');

      const moreNote =
        data.totalFound > data.results.length
          ? `<p style="color:var(--text-low); font-size:.78rem; margin-top:10px;">+ ${data.totalFound - data.results.length} more found — full list &amp; automatic takedowns with a subscription.</p>`
          : '';

      resultsBox.innerHTML = `
        <p style="color:var(--coral); font-size:.85rem; margin:0 0 4px; font-weight:600;">${data.totalFound} possible match(es) found:</p>
        ${rows}
        ${moreNote}
        <a href="register.html" class="btn btn-primary" style="margin-top:14px; display:inline-flex;">Get Full Protection</a>
      `;
    } catch (err) {
      console.error('Free scan error:', err);
      resultsBox.innerHTML = `<p style="color:#0096F5; font-size:.85rem; margin:0;">Could not reach the scan server. Please try again in a moment.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  btn.addEventListener('click', runScan);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runScan();
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ---------------- Live scan-to-takedown demo cycle ----------------
function initScanDemo() {
  const rows = document.querySelectorAll('[data-demo-row]');
  if (!rows.length) return;

  const stages = ['found', 'sent', 'removed'];
  const dotEl = (row) => row.querySelector('.dot');
  const badgeEl = (row) => row.querySelector('.badge');

  const stageLabel = { found: 'Leak Found', sent: 'DMCA Sent', removed: 'Removed' };

  let tick = 0;
  setInterval(() => {
    tick++;
    rows.forEach((row, i) => {
      const stageIndex = (tick + i) % stages.length;
      const stage = stages[stageIndex];
      const dot = dotEl(row);
      const badge = badgeEl(row);
      if (dot) {
        dot.className = 'dot ' + stage;
      }
      if (badge) {
        badge.className = 'badge ' + stage;
        badge.textContent = stageLabel[stage];
      }
    });
  }, 2200);
}
