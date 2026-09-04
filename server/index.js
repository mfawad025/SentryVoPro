/**
 * SentryVo backend
 * --------------------
 * 1. Registration — captures plan (single/multi), platforms, stage-name
 *    aliases, and links to the CREATOR'S OWN original content (proof of
 *    ownership — never the infringing link), then redirects to Lemon
 *    Squeezy's hosted checkout for payment.
 * 2. Lemon Squeezy webhook — activates the account once payment succeeds.
 * 3. Real login sessions — a random token stored in the `sessions` table,
 *    set as an httpOnly cookie. Not a JWT — this is intentionally
 *    revocable (logout actually deletes the session row), which a
 *    stateless JWT can't do without extra machinery.
 * 4. Dashboard data endpoints — real per-user leaks/stats from Postgres,
 *    replacing the old static mockup numbers in dashboard.html.
 * 5. Daily cron (see cron.js / scanner.js) — scans, attempts takedowns,
 *    and emails each active subscriber a report on their plan's cadence.
 *
 * IMPORTANT — before going live:
 *   - Set DATABASE_URL to your Neon (or other Postgres) connection string.
 *   - Create two products/variants in your Lemon Squeezy dashboard, grab
 *     each one's checkout link from Share, put them in .env.
 *   - Set your webhook URL in Lemon Squeezy to
 *     https://<your-backend>/api/lemonsqueezy/webhook, subscribed to at
 *     least order_created and subscription_created.
 *   - Copy the webhook signing secret into LEMONSQUEEZY_WEBHOOK_SECRET.
 */

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const { buildCheckoutUrl, verifyWebhookSignature } = require('./lemonsqueezy');
const { startDailyScanCron } = require('./cron');
const { searchGoogle } = require('./googleSearch');

const app = express();
app.set('trust proxy', 1); // needed so express-rate-limit sees real visitor IPs behind Render/Railway/etc.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// credentials:true + an explicit origin (not '*') are both required for
// cookies to actually work cross-origin between your frontend and backend.
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(cookieParser());

const SESSION_COOKIE_NAME = 'sv_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The Lemon Squeezy webhook needs the RAW body to verify its signature, so
// it must be registered before the general express.json() body parser.
app.post(
  '/api/lemonsqueezy/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.header('X-Signature');
      if (!verifyWebhookSignature(req.body, signature)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const event = JSON.parse(req.body.toString('utf8'));
      const eventName = event?.meta?.event_name;
      const checkoutRef = event?.meta?.custom_data?.user_id;
      const subscriptionId = event?.data?.type === 'subscriptions' ? event.data.id : null;

      if (!checkoutRef) {
        console.warn('Lemon Squeezy webhook missing custom_data.user_id — cannot link to a user', eventName);
        return res.status(200).json({ received: true, note: 'no user_id in custom_data' });
      }

      if (eventName === 'order_created' || eventName === 'subscription_created') {
        await db.setUserActiveByCheckoutRef(String(checkoutRef), subscriptionId);
        console.log(`Activated user (checkout_ref ${checkoutRef}) via ${eventName}`);
      } else {
        console.log(`Lemon Squeezy webhook received: ${eventName} (no action taken)`);
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('Lemon Squeezy webhook error:', err.message);
      // Still 200 so Lemon Squeezy doesn't hammer retries for a parsing bug
      // on our side while we fix it — but log loudly so it gets noticed.
      res.status(200).json({ received: true, error: 'processing_failed' });
    }
  }
);

app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------- Auth middleware ----------------
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    const session = await db.getSession(token);
    if (!session) return res.status(401).json({ error: 'Session expired — please log in again' });

    const user = await db.getUserById(session.user_id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth check failed:', err.message);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

// ---------------- Free scan (public, no login) ----------------
// Real search, real results — but this is a public, unauthenticated
// endpoint, so it's rate-limited two ways:
//   1. Per visitor: 3 free scans per IP per day (express-rate-limit)
//   2. Site-wide: a hard daily cap so anonymous traffic can't eat the
//      Google Custom Search quota your paying subscribers' daily scans
//      depend on. Adjust FREE_SCAN_DAILY_SITE_CAP in .env as your quota allows.
const freeScanPerIpLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Free scan limit reached for today. Sign up for continuous protection instead.' },
});

let siteWideScanCount = 0;
let siteWideScanResetAt = startOfNextDay();
function startOfNextDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
function siteWideCapReached() {
  if (Date.now() >= siteWideScanResetAt) {
    siteWideScanCount = 0;
    siteWideScanResetAt = startOfNextDay();
  }
  const cap = Number(process.env.FREE_SCAN_DAILY_SITE_CAP || 25);
  return siteWideScanCount >= cap;
}

app.post('/api/scan/free', freeScanPerIpLimiter, async (req, res) => {
  try {
    const alias = String(req.body?.alias || '').trim();
    if (alias.length < 2) {
      return res.status(400).json({ error: 'Enter a name or username to scan (at least 2 characters).' });
    }
    if (alias.length > 60) {
      return res.status(400).json({ error: 'That name is too long — try just the stage name or username.' });
    }
    if (siteWideCapReached()) {
      return res.status(429).json({ error: 'Free scans are fully booked for today — try again tomorrow, or sign up for continuous protection.' });
    }

    siteWideScanCount++;
    const results = await searchGoogle(`"${alias}" leaked`);

    res.json({
      alias,
      totalFound: results.length,
      results: results.slice(0, 3), // show a taste; full list is a subscriber feature
    });
  } catch (err) {
    console.error('Free scan error:', err.message);
    res.status(502).json({ error: 'Scan is temporarily unavailable — please try again shortly.' });
  }
});

// ---------------- Registration (creates account + starts Lemon Squeezy checkout) ----------------
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, mobile, password, plan, platforms, aliases, originalLinks } = req.body || {};

    if (!name || !email || !mobile || !password || !plan) {
      return res.status(400).json({ error: 'name, email, mobile, password and plan are required' });
    }
    if (!['single', 'multi'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be "single" or "multi"' });
    }

    const platformList = Array.isArray(platforms)
      ? platforms
      : String(platforms || '').split(',').map((p) => p.trim()).filter(Boolean);
    if (plan === 'single' && platformList.length > 1) {
      return res.status(400).json({ error: 'The Single Keyword/Account plan covers exactly one platform. Choose Multiple Keywords/Accounts for more.' });
    }
    if (!platformList.length) {
      return res.status(400).json({ error: 'Select at least one platform' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userId = await db.createUser({
      name,
      email,
      mobile,
      passwordHash,
      plan,
      platforms: platformList.join(','),
      checkoutRef: null,
    });
    // Use the row id itself as the checkout reference passed to Lemon Squeezy.
    await db.setUserCheckoutRef(userId, String(userId));

    const aliasList = Array.isArray(aliases) ? aliases : String(aliases || '').split(',').map((a) => a.trim());
    await db.addAliases(userId, aliasList.length ? aliasList : [name]);

    const linkList = Array.isArray(originalLinks)
      ? originalLinks
      : String(originalLinks || '').split('\n').map((l) => l.trim());
    await db.addOriginalLinks(userId, linkList);

    const checkoutUrl = buildCheckoutUrl(plan, { userId, name, email });

    res.json({ checkoutUrl, userId });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Could not create your account. Please try again shortly.' });
  }
});

// ---------------- Login (real session, httpOnly cookie) ----------------
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await db.getUserByEmail(email);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash || '')) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await db.createSession(token, user.id, expiresAt);

    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true, // requires HTTPS — both your frontend and backend already use it
      sameSite: 'none', // needed since frontend (GitHub Pages) and backend (Render) are different domains
      maxAge: SESSION_DURATION_MS,
    });

    res.json({ ok: true, name: user.name, plan: user.plan, status: user.status });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again shortly.' });
  }
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (token) await db.deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

// ---------------- Dashboard data (real, per logged-in user) ----------------
app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const summary = await db.getLeakSummary(req.user.id);
    res.json({
      name: req.user.name,
      email: req.user.email,
      plan: req.user.plan,
      status: req.user.status,
      platforms: (req.user.platforms || '').split(',').filter(Boolean),
      reportFrequencyDays: req.user.report_frequency_days,
      lastReportAt: req.user.last_report_at,
      summary,
    });
  } catch (err) {
    console.error('Dashboard summary error:', err.message);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

app.get('/api/dashboard/leaks', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const leaks = await db.getAllLeaksForUser(req.user.id, { limit, offset });
    res.json({ leaks });
  } catch (err) {
    console.error('Dashboard leaks error:', err.message);
    res.status(500).json({ error: 'Could not load leak data' });
  }
});

// ---------------- Manual trigger for testing the scan pipeline ----------------
app.post('/api/scan/run-now', async (req, res) => {
  try {
    const { runDailyScanForAllUsers } = require('./scanner');
    const results = await runDailyScanForAllUsers();
    res.json({ ok: true, results });
  } catch (err) {
    console.error('Manual scan trigger failed:', err.message);
    res.status(500).json({ error: 'Scan failed to run' });
  }
});

const PORT = process.env.PORT || 4242;

// Wait for the database schema to be ready before accepting traffic —
// avoids a race where the first request hits before tables exist.
db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SentryVo server listening on port ${PORT}`);
      startDailyScanCron();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema — check DATABASE_URL:', err.message);
    process.exit(1);
  });
