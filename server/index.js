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
const fingerprint = require('./fingerprint');
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

        // Subscription events include a "manage your subscription" portal
        // link — capture it if present so the dashboard's Billing tab can
        // link straight there. Not present on order_created for one-time
        // orders, so this is best-effort and gracefully absent otherwise.
        const portalUrl = event?.data?.attributes?.urls?.customer_portal;
        if (portalUrl) {
          const user = await db.getUserByEmail(event?.data?.attributes?.user_email || '');
          if (user) await db.setCustomerPortalUrl(user.id, portalUrl);
        }
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

// ---------------- Content fingerprints (admin) ----------------
// Usage: POST https://api.sentryvo.com/api/admin/fingerprint/add?key=ADMIN_KEY&userId=ID
// Body: the raw image file (Content-Type: image/jpeg, image/png, image/webp...)
//
// Stores only a 16-character perceptual hash of the client's ORIGINAL photo
// — the image itself is discarded immediately. The scanner then recognises
// re-uploads of that photo (see fingerprint.js). Registered BEFORE the
// general express.json() parser because the body is a raw image, not JSON.
app.post(
  '/api/admin/fingerprint/add',
  express.raw({ type: 'image/*', limit: '12mb' }),
  async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    try {
      const userId = Number(req.query.userId);
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const user = await db.getUserById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'Send the image file as the raw request body (Content-Type: image/*)' });
      }

      const hashed = await fingerprint.hashImageBuffer(req.body);
      if (!hashed) {
        return res.status(422).json({ error: 'Could not fingerprint this image (unreadable, or too plain/uniform to be distinctive).' });
      }

      const outcome = await db.addFingerprint(userId, hashed.hash);
      if (outcome === 'limit') {
        return res.status(409).json({ error: `Limit reached (${db.MAX_FINGERPRINTS_PER_USER} fingerprints per client).` });
      }
      const total = await db.countFingerprints(userId);
      res.json({ ok: true, outcome, total });
    } catch (err) {
      console.error('Fingerprint add error:', err.message);
      res.status(500).json({ error: 'Could not process this image.' });
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
//      Serper.dev quota your paying subscribers' daily scans
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

// ---------------- Agency registration (owner account + billing) ----------------
// Creates the agency container plus its OWNER as a normal `users` row — this
// deliberately reuses the exact same Lemon Squeezy checkout + webhook
// activation flow as individual registration above, so nothing about
// payment handling needed to change. Only Starter/Growth are self-serve;
// Enterprise is routed to the Contact Sales form on agencies.html instead.
app.post('/api/register/agency', async (req, res) => {
  try {
    const { agencyName, ownerName, email, mobile, password, tier } = req.body || {};

    if (!agencyName || !ownerName || !email || !mobile || !password || !tier) {
      return res.status(400).json({ error: 'agencyName, ownerName, email, mobile, password and tier are required' });
    }
    if (!['agency_starter', 'agency_growth'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be "agency_starter" or "agency_growth" (Enterprise uses the Contact Sales form instead)' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const agencyId = await db.createAgency({ name: agencyName, tier });

    const passwordHash = bcrypt.hashSync(password, 10);
    const ownerId = await db.createUser({
      name: ownerName,
      email,
      mobile,
      passwordHash,
      plan: tier, // stored for display purposes, same field individual users use for 'single'/'multi'
      platforms: '', // the owner isn't necessarily a content creator themselves
      checkoutRef: null,
      agencyId,
      role: 'agency_owner',
    });
    await db.setUserCheckoutRef(ownerId, String(ownerId));

    const checkoutUrl = buildCheckoutUrl(tier, { userId: ownerId, name: ownerName, email });

    res.json({ checkoutUrl, agencyId, ownerId });
  } catch (err) {
    console.error('Agency registration error:', err.message);
    res.status(500).json({ error: 'Could not create your agency account. Please try again shortly.' });
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

    res.json({ ok: true, name: user.name, plan: user.plan, status: user.status, role: user.role });
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

// ---------------- Forgot / reset password ----------------
const RESET_TOKEN_DURATION_MS = 60 * 60 * 1000; // 1 hour

app.post('/api/forgot-password', async (req, res) => {
  try {
    const email = req.body?.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await db.getUserByEmail(email);
    // Deliberately the SAME response whether or not the account exists —
    // this stops a visitor from using this form to check which email
    // addresses have a SentryVo account (a real, if minor, privacy leak
    // if the two cases returned different messages).
    const genericResponse = {
      ok: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    };

    if (!user) {
      return res.json(genericResponse);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_DURATION_MS);
    await db.createPasswordResetToken(token, user.id, expiresAt);

    const siteUrl = process.env.SENTRYVO_SITE_URL || 'https://www.sentryvo.com';
    const resetUrl = `${siteUrl}/reset-password.html?token=${token}`;

    const { sendPasswordResetEmail } = require('./emailReport');
    await sendPasswordResetEmail(user.email, resetUrl);

    res.json(genericResponse);
  } catch (err) {
    console.error('Forgot-password error:', err.message);
    // Still return the generic message even on an internal error, for the
    // same account-enumeration reason as above — log the real error
    // server-side instead of exposing it to the visitor.
    res.json({ ok: true, message: 'If an account exists with that email, a password reset link has been sent.' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Choose a password at least 6 characters long' });
    }

    const resetRecord = await db.getPasswordResetToken(token);
    if (!resetRecord) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await db.setUserPasswordHash(resetRecord.user_id, passwordHash);
    await db.deletePasswordResetToken(token); // single-use — can't be replayed

    res.json({ ok: true, message: 'Password updated — you can log in with your new password now.' });
  } catch (err) {
    console.error('Reset-password error:', err.message);
    res.status(500).json({ error: 'Could not reset your password. Please try again shortly.' });
  }
});

// ---------------- Dashboard data (real, per logged-in user) ----------------
// Both endpoints default to the logged-in user's own data. An agency owner
// can pass ?userId=X to view a specific creator on their roster instead —
// authorization requires either viewing yourself, or being the agency_owner
// of that user's agency (never anyone else's account).
async function resolveTargetUser(req) {
  const requestedId = req.query?.userId;
  if (!requestedId || Number(requestedId) === req.user.id) {
    return req.user;
  }
  if (req.user.role !== 'agency_owner') {
    return null; // not authorized to view anyone else's data
  }
  const target = await db.getUserById(requestedId);
  if (!target || target.agency_id !== req.user.agency_id) {
    return null; // not your roster
  }
  return target;
}

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const target = await resolveTargetUser(req);
    if (!target) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    const summary = await db.getLeakSummary(target.id);
    const aliases = await db.getAliasesForUser(target.id);
    const originalLinks = await db.getOriginalLinksForUser(target.id);
    res.json({
      name: target.name,
      email: target.email,
      plan: target.plan,
      status: target.status,
      role: target.role,
      platforms: (target.platforms || '').split(',').filter(Boolean),
      reportFrequencyDays: target.report_frequency_days,
      lastReportAt: target.last_report_at,
      aliases,
      originalLinks,
      customerPortalUrl: target.ls_customer_portal_url || null,
      summary,
    });
  } catch (err) {
    console.error('Dashboard summary error:', err.message);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

app.get('/api/dashboard/leaks', requireAuth, async (req, res) => {
  try {
    const target = await resolveTargetUser(req);
    if (!target) {
      return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const leaks = await db.getAllLeaksForUser(target.id, { limit, offset });
    res.json({ leaks });
  } catch (err) {
    console.error('Dashboard leaks error:', err.message);
    res.status(500).json({ error: 'Could not load leak data' });
  }
});

// ---------------- Dashboard: Brand Profile & account management ----------------
// Adds one alias to the logged-in user's own account — powers the Brand
// Profile tab's "add a stage name" form.
app.post('/api/dashboard/add-alias', requireAuth, async (req, res) => {
  try {
    const alias = req.body?.alias?.trim();
    if (!alias) return res.status(400).json({ error: 'alias is required' });
    await db.addAliases(req.user.id, [alias]);
    res.json({ ok: true, message: `Added "${alias}" to your monitored aliases` });
  } catch (err) {
    console.error('Add alias error:', err.message);
    res.status(500).json({ error: 'Could not add alias' });
  }
});

// Adds one original-content link (proof of ownership) — same isOwnContent
// exclusion in scanner.js reads from this same table, so adding a link
// here immediately protects that platform from ever being flagged as a leak.
app.post('/api/dashboard/add-original-link', requireAuth, async (req, res) => {
  try {
    const url = req.body?.url?.trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    await db.addOriginalLinks(req.user.id, [url]);
    res.json({ ok: true, message: 'Added — this link will never be flagged as a leak going forward' });
  } catch (err) {
    console.error('Add original link error:', err.message);
    res.status(500).json({ error: 'Could not add link' });
  }
});

// Change password while logged in — different from the forgot-password
// flow, which is for when you DON'T have access to your account. This
// requires knowing your current password first.
app.post('/api/dashboard/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Choose a new password at least 6 characters long' });
    }
    if (!bcrypt.compareSync(currentPassword, req.user.password_hash || '')) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const newHash = bcrypt.hashSync(newPassword, 10);
    await db.setUserPasswordHash(req.user.id, newHash);
    res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Could not update password' });
  }
});

// ---------------- Agency: roster + adding creators ----------------
function requireAgencyOwner(req, res) {
  if (req.user.role !== 'agency_owner') {
    res.status(403).json({ error: 'This account is not an agency owner' });
    return false;
  }
  return true;
}

// Returns the agency's info plus every creator on the roster, each with
// their own leak summary — the main data source for agency-dashboard.html.
app.get('/api/agency/roster', requireAuth, async (req, res) => {
  if (!requireAgencyOwner(req, res)) return;
  try {
    const agency = await db.getAgencyById(req.user.agency_id);
    const members = await db.getAgencyMembers(req.user.agency_id);

    const membersWithSummary = await Promise.all(
      members.map(async (m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        status: m.status,
        platforms: (m.platforms || '').split(',').filter(Boolean),
        summary: await db.getLeakSummary(m.id),
      }))
    );

    res.json({
      agency: { id: agency.id, name: agency.name, tier: agency.tier, maxCreators: agency.max_creators },
      ownerStatus: req.user.status, // whether the agency's own subscription is active
      memberCount: membersWithSummary.length,
      members: membersWithSummary,
    });
  } catch (err) {
    console.error('Agency roster error:', err.message);
    res.status(500).json({ error: 'Could not load agency roster' });
  }
});

// Adds a new creator to the agency's roster. No separate Lemon Squeezy
// checkout — the agency already pays for the whole roster, so the new
// creator's account is active immediately, up to the tier's creator limit.
app.post('/api/agency/add-creator', requireAuth, async (req, res) => {
  if (!requireAgencyOwner(req, res)) return;
  try {
    if (req.user.status !== 'active') {
      return res.status(402).json({ error: 'Your agency subscription is not active yet — complete checkout before adding creators.' });
    }

    const agency = await db.getAgencyById(req.user.agency_id);
    if (agency.max_creators !== null) {
      const currentCount = await db.countAgencyMembers(req.user.agency_id);
      if (currentCount >= agency.max_creators) {
        return res.status(400).json({ error: `Your ${agency.tier.replace('agency_', '')} plan covers up to ${agency.max_creators} creators. Upgrade your tier to add more.` });
      }
    }

    const { name, email, password, platforms, aliases, originalLinks } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const platformList = Array.isArray(platforms) ? platforms : String(platforms || '').split(',').map((p) => p.trim()).filter(Boolean);
    const passwordHash = bcrypt.hashSync(password, 10);

    const memberId = await db.createUser({
      name,
      email,
      mobile: '', // optional for agency-added creators
      passwordHash,
      plan: agency.tier,
      platforms: platformList.join(','),
      checkoutRef: null,
      agencyId: req.user.agency_id,
      role: 'agency_member',
    });

    const aliasList = Array.isArray(aliases) ? aliases : String(aliases || '').split(',').map((a) => a.trim());
    await db.addAliases(memberId, aliasList.length ? aliasList : [name]);

    const linkList = Array.isArray(originalLinks) ? originalLinks : String(originalLinks || '').split('\n').map((l) => l.trim());
    await db.addOriginalLinks(memberId, linkList);

    res.json({ ok: true, memberId, message: `${name} added to your roster and active immediately` });
  } catch (err) {
    console.error('Add creator error:', err.message);
    res.status(500).json({ error: 'Could not add creator. Please try again shortly.' });
  }
});

// ---------------- Manual trigger for testing the scan pipeline ----------------
// GET version: just visit this URL directly in a browser, no extra tools needed.
app.get('/api/scan/run-now', async (req, res) => {
  try {
    const { runDailyScanForAllUsers } = require('./scanner');
    const results = await runDailyScanForAllUsers();
    res.json({ ok: true, results });
  } catch (err) {
    console.error('Manual scan trigger failed:', err.message);
    res.status(500).json({ error: 'Scan failed to run' });
  }
});

// POST version, for anyone using a tool like Postman/curl instead.
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

// ---------------- Manual trigger for testing SMTP in isolation ----------------
// Sends one bare test email, independent of the scan/report pipeline — the
// fastest way to confirm SMTP_HOST/PORT/USER/PASS actually work without
// needing an active subscriber or waiting for the daily cron.
//
// GET version: just visit this URL directly in a browser, no extra tools
// needed — e.g. https://api.sentryvo.com/api/test-email?to=you@example.com
app.get('/api/test-email', async (req, res) => {
  try {
    const { sendTestEmail } = require('./emailReport');
    const to = req.query?.to || process.env.SMTP_USER;
    if (!to) {
      return res.status(400).json({ error: 'Add ?to=you@example.com to the URL' });
    }
    await sendTestEmail(to);
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    console.error('Test email failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST version, for anyone using a tool like Postman/curl instead.
app.post('/api/test-email', async (req, res) => {
  try {
    const { sendTestEmail } = require('./emailReport');
    const to = req.body?.to || process.env.SMTP_USER;
    if (!to) {
      return res.status(400).json({ error: 'Provide { "to": "you@example.com" } in the request body' });
    }
    await sendTestEmail(to);
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    console.error('Test email failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Emergency admin: find & deactivate an account ----------------
// No admin panel exists yet — these two browser-visitable routes are a
// stopgap for exactly one situation: a test/mistaken account went live and
// needs to be found and stopped from being scanned again, fast, without
// needing direct database access.
//
// Protected by a shared secret (ADMIN_SECRET_KEY in .env) so a random
// visitor can't look up or modify real subscriber accounts just by finding
// the URL. Treat this key like a password — don't share it, don't commit
// it to a public file.
function checkAdminKey(req, res) {
  const key = req.query?.key;
  const expected = process.env.ADMIN_SECRET_KEY;
  if (!expected || expected === 'change_me_to_something_random') {
    res.status(500).json({ error: 'ADMIN_SECRET_KEY is not configured — set it in your environment first' });
    return false;
  }
  if (key !== expected) {
    res.status(401).json({ error: 'Invalid or missing ?key=' });
    return false;
  }
  return true;
}

// Usage: https://api.sentryvo.com/api/admin/google-delist?userId=ID&key=YOUR_ADMIN_KEY
//   optional: &all=yes  include links already marked as submitted to Google
//
// Returns the client's leak PAGE links that still need a Google removal
// (delisting) request — not removed, not dismissed, and not already exported.
// Paste them into Google's DMCA form (see formUrl). After submitting, call
// POST /api/admin/google-delist/mark with { userId, leakIds } so the next
// export only contains new links.
app.get('/api/admin/google-delist', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { googleDelistUrl, GOOGLE_DMCA_FORM_URL } = require('./constants');
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const leaks = await db.getLeaksForGoogleDelist(userId, { includeSubmitted: req.query.all === 'yes' });
    const seen = new Set();
    const items = [];
    for (const leak of leaks) {
      const url = googleDelistUrl(leak);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({ leakId: leak.id, url });
    }
    // One page can carry several leaks (an album page + its images) —
    // report every leak id behind a page so marking one marks them all.
    const idsByUrl = new Map();
    for (const leak of leaks) {
      const url = googleDelistUrl(leak);
      if (!url) continue;
      if (!idsByUrl.has(url)) idsByUrl.set(url, []);
      idsByUrl.get(url).push(leak.id);
    }
    res.json({
      ok: true,
      client: { id: user.id, name: user.name, email: user.email },
      formUrl: GOOGLE_DMCA_FORM_URL,
      count: items.length,
      urls: items.map((i) => i.url),
      leakIds: Array.from(idsByUrl.values()).flat(),
    });
  } catch (err) {
    console.error('Google delist export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Body: { userId, leakIds: [1,2,3] } — marks those leaks as submitted to Google.
app.post('/api/admin/google-delist/mark', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const userId = Number(req.body?.userId);
    const ids = (Array.isArray(req.body?.leakIds) ? req.body.leakIds : []).map(Number).filter(Number.isInteger);
    if (!userId || !ids.length) return res.status(400).json({ error: 'userId and leakIds are required' });
    const marked = await db.markGoogleSubmitted(userId, ids);
    res.json({ ok: true, marked });
  } catch (err) {
    console.error('Google delist mark error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/fingerprint/count?userId=ID&key=YOUR_ADMIN_KEY
app.get('/api/admin/fingerprint/count', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    res.json({ ok: true, userId, total: await db.countFingerprints(userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/fingerprint/clear?userId=ID&key=YOUR_ADMIN_KEY&confirm=yes
// Removes all stored fingerprints for one client (e.g. to re-upload a cleaner set).
app.get('/api/admin/fingerprint/clear', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'Add &confirm=yes to confirm' });
    res.json({ ok: true, removed: await db.clearFingerprints(userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usage: POST https://api.sentryvo.com/api/admin/replace-aliases?key=YOUR_ADMIN_KEY
// Body: { userId, aliases: ["kitsykat", "jaxi asmr"] }
//
// Wipes this user's existing aliases and replaces them with the given list
// — for fixing aliases that were entered wrong (e.g. full search phrases
// like "kitsykat nude" or "kitsykat only fans" instead of just the plain
// stage name "kitsykat"). buildTextQueries() in scanner.js already adds
// "leaked", "nude", "naked", platform names, and site: filters around
// whatever you put here — so this field should only ever hold the bare
// name/username to monitor, nothing more.
app.post('/api/admin/replace-aliases', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { userId, aliases } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const aliasList = Array.isArray(aliases)
      ? aliases
      : String(aliases || '').split(',').map((a) => a.trim());

    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: `No user found with id ${userId}` });

    const saved = await db.replaceAliases(userId, aliasList);
    res.json({ ok: true, message: `Aliases for ${user.email} replaced`, aliases: saved });
  } catch (err) {
    console.error('Admin replace-aliases failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not replace aliases' });
  }
});

// Usage: https://api.sentryvo.com/api/admin/find-user?alias=kitsykat&key=YOUR_ADMIN_KEY
// Searches both aliases and email addresses (partial match, case-insensitive).
app.get('/api/admin/find-user', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const term = req.query?.alias || req.query?.email || req.query?.q;
    if (!term) {
      return res.status(400).json({ error: 'Add ?alias=searchterm (or ?email=...) to the URL' });
    }
    const users = await db.findUsersByAliasOrEmail(term);
    res.json({ ok: true, count: users.length, users });
  } catch (err) {
    console.error('Admin find-user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/deactivate-user?id=USER_ID&key=YOUR_ADMIN_KEY
// Sets the account's status to 'cancelled' — getActiveUsers() (used by the
// daily scan) will stop including it immediately. Does NOT delete any data
// or leaks already recorded — it only stops future scanning/emailing.
app.get('/api/admin/deactivate-user', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const id = req.query?.id;
    if (!id) {
      return res.status(400).json({ error: 'Add ?id=USER_ID to the URL — get this from /api/admin/find-user first' });
    }
    const user = await db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: `No user found with id ${id}` });
    }
    await db.setUserStatus(id, 'cancelled');
    res.json({ ok: true, message: `User ${user.email} (id ${id}) set to cancelled — will no longer be scanned or emailed` });
  } catch (err) {
    console.error('Admin deactivate-user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/activate-user?id=USER_ID&key=YOUR_ADMIN_KEY
// Manually flips an account to 'active' WITHOUT a real payment — exists
// specifically so you can see the dashboard populated with real scan data
// for testing purposes, without needing to run a real transaction through
// your own linked bank account. Only ever use this on accounts you
// control/created yourself for testing — never on a real customer's
// account, since that would give them access without them actually paying.
app.get('/api/admin/activate-user', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const id = req.query?.id;
    if (!id) {
      return res.status(400).json({ error: 'Add ?id=USER_ID to the URL — get this from /api/admin/find-user first' });
    }
    const user = await db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: `No user found with id ${id}` });
    }
    await db.setUserStatus(id, 'active');
    res.json({ ok: true, message: `User ${user.email} (id ${id}) set to active — will be included in the next scan` });
  } catch (err) {
    console.error('Admin activate-user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/delete-user?id=USER_ID&key=YOUR_ADMIN_KEY&confirm=yes
// PERMANENTLY deletes the account and everything tied to it (aliases,
// original links, leaks, reports, sessions) — there is no undo. Requires
// &confirm=yes explicitly in the URL so a stray click or bookmark can't
// accidentally wipe a real account. For most cleanup, deactivate-user above
// is the safer choice — only use this when you actually want the record
// gone entirely (e.g. a test account, or freeing up an email for reuse).
app.get('/api/admin/delete-user', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const id = req.query?.id;
    if (!id) {
      return res.status(400).json({ error: 'Add ?id=USER_ID to the URL — get this from /api/admin/find-user first' });
    }
    if (req.query?.confirm !== 'yes') {
      return res.status(400).json({
        error: 'This permanently deletes the account and cannot be undone. Add &confirm=yes to the URL to proceed.',
      });
    }
    const user = await db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: `No user found with id ${id}` });
    }
    const deleted = await db.deleteUser(id);
    res.json({ ok: true, message: `Permanently deleted user ${deleted.email} (id ${id}) and all associated data` });
  } catch (err) {
    console.error('Admin delete-user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/reset-password?id=USER_ID&newPassword=SOMETHING&key=YOUR_ADMIN_KEY
// Sets a new password for an account whose password was forgotten — keeps
// all their data intact (unlike delete-user). The new password is hashed
// with bcrypt before storage, same as at registration; it's never stored
// or logged in plain text.
app.get('/api/admin/reset-password', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const id = req.query?.id;
    const newPassword = req.query?.newPassword;
    if (!id || !newPassword) {
      return res.status(400).json({ error: 'Add both ?id=USER_ID and &newPassword=SOMETHING to the URL' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Choose a password at least 6 characters long' });
    }
    const user = await db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: `No user found with id ${id}` });
    }
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await db.setUserPasswordHash(id, passwordHash);
    res.json({ ok: true, message: `Password reset for ${user.email} — you can log in with the new password now` });
  } catch (err) {
    console.error('Admin reset-password failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Site contact email lookup (manually verified) ----------------
// Usage: https://api.sentryvo.com/api/admin/site-emails/list?key=YOUR_ADMIN_KEY
app.get('/api/admin/site-emails/list', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const entries = await db.listSiteContactEmails();
    res.json({ ok: true, count: entries.length, entries });
  } catch (err) {
    console.error('Admin site-emails/list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/site-emails/add?domain=example.com&email=dmca@example.com&key=YOUR_ADMIN_KEY
// Adds a new entry, or updates the email if that domain already exists —
// this is how you add or change entries going forward, one at a time.
app.get('/api/admin/site-emails/add', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const domain = req.query?.domain?.toLowerCase().replace(/^www\./, '');
    const email = req.query?.email;
    if (!domain || !email) {
      return res.status(400).json({ error: 'Add both ?domain=example.com and &email=dmca@example.com to the URL' });
    }
    await db.upsertSiteContactEmail(domain, email);
    res.json({ ok: true, message: `Saved: ${domain} -> ${email}` });
  } catch (err) {
    console.error('Admin site-emails/add failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/site-emails/delete?domain=example.com&key=YOUR_ADMIN_KEY
app.get('/api/admin/site-emails/delete', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const domain = req.query?.domain?.toLowerCase().replace(/^www\./, '');
    if (!domain) {
      return res.status(400).json({ error: 'Add ?domain=example.com to the URL' });
    }
    await db.deleteSiteContactEmail(domain);
    res.json({ ok: true, message: `Removed: ${domain}` });
  } catch (err) {
    console.error('Admin site-emails/delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-time bulk import of the 124 manually-verified domain/email pairs
// supplied when this feature was built. Safe to run more than once —
// upsertSiteContactEmail overwrites rather than duplicates. Visit this
// URL once after deploying, then use /add and /delete above for anything
// going forward instead of re-running this.
// Usage: https://api.sentryvo.com/api/admin/site-emails/seed?key=YOUR_ADMIN_KEY
app.get('/api/admin/site-emails/seed', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const seedData = [
      { domain: 'leakedzone.com', email: 'contact.leakedzone@gmail.com' },
      { domain: 'leakgallery.com', email: 'dmca@leakgallery.com' },
      { domain: 'wildskirts.com', email: 'hello.wildskirts@gmail.com' },
      { domain: 'fapomania.com', email: 'fapomania990+dmca@gmail.com' },
      { domain: 'leaks4fap.com', email: 'abuseandpr@leaks4fap.com' },
      { domain: 'rapelust.com', email: 'rapelust.com@gmail.com' },
      { domain: 'playvids.com', email: 'legal@playvids.com' },
      { domain: 'pornuvexa.com', email: 'sandleradams490@gmail.com' },
      { domain: 'pornvod18.com', email: 'breckieh07@gmail.com' },
      { domain: 'nudevista.net', email: 'dmca@nudevista.com' },
      { domain: 'youjizz.com', email: 'youjizzadmin@gmail.com' },
      { domain: 'motherless.xxx', email: 'dmca@motherless.xxx' },
      { domain: 'eporner.com', email: 'notice@dmcanow.io' },
      { domain: 'cz.thefappening.plus', email: 'johnstevensonday+dmca@gmail.com' },
      { domain: 'porno.supply', email: 'help@porno.supply' },
      { domain: 'bunkr.cr', email: 'support@bunker.services' },
      { domain: 'forums.socialmediagirls.com', email: 'socialmediagirls-takedown@proton.me' },
      { domain: 'fotosdemujeresdesnudas.com', email: 'notice@fotosdemujeresdesnudas.com' },
      { domain: 'topfapgirlspics.com', email: 'piava@topfapgirlspics.com' },
      { domain: 'masterfap.net', email: 'dmcamasterfap@protonmail.com' },
      { domain: 'fapexy.com', email: 'fapexyweb@gmail.com' },
      { domain: 'bilibili.com', email: 'legal-notice@bilibili.com' },
      { domain: 'reddxxx.com', email: 'contact@reddxxx.com' },
      { domain: 'shemalevids.org', email: 'shemalevids.reuploads@proton.me' },
      { domain: 'transporn.cc', email: 'alesldvnikv@gmail.com' },
      { domain: 'xxx-porn-hub.com', email: 'copyright@xxx-porn-hub.com' },
      { domain: 'tubegalore.com', email: 'dmca@tubetraffic.com' },
      { domain: 'fapellino.com', email: 'fapellino@gmail.com' },
      { domain: 'ibj.tw', email: 'abuse@onlyfuns.win' },
      { domain: 'imagenespng.net', email: 'abuse@cutefans.win' },
      { domain: 'picazor.com', email: 'dmca@picazor.com' },
      { domain: 'tyler-brown.com', email: 'abuse@tyler-brown.com' },
      { domain: 'iceporn.com', email: 'copyright@iceporn.com' },
      { domain: 'of.celebexposed.com', email: 'contact@of.celebexposed.com' },
      { domain: 'fapachi.com', email: 'adminfap@fapachi.com' },
      { domain: 'pimpbunny.com', email: 'valevy00z@gmail.com' },
      { domain: 'fapmenu.com', email: 'admincrew@fapmenu.com' },
      { domain: 'ilovnudes.com', email: 'shreyasharmasky@gmail.com' },
      { domain: 'actionviewphotography.com', email: 'abuse@actionviewphotography.com' },
      { domain: 'mym-db.com', email: 'contact@mym-db.com' },
      { domain: 'ashemaletube.com', email: 'dmca@ashemaletube.com' },
      { domain: 'mat6tube.com', email: 'abuse@mat6tube.com' },
      { domain: 'noodlemagazine.com', email: 'abuse@noodlemagazine.com' },
      { domain: 'senjo-pianist.jp', email: 'abuse@cutefans.win' },
      { domain: 'ukdevilz.com', email: 'abuse@ukdevilz.com' },
      { domain: 'simpthots.com', email: 'simpthots@proton.me' },
      { domain: 'infotourism.news', email: 'contact@cutefans.win' },
      { domain: 'erome.com', email: 'contact@erome.com' },
      { domain: 'thefappening2015.com', email: 'lamelamer8@gmail.com' },
      { domain: 'fap.thefappening.one', email: 'lamelamer8@gmail.com' },
      { domain: 'fuckingdate.net', email: 'dmca@fuckingdate.net' },
      { domain: 'glamourhound.com', email: 'dmca@glamourhound.com' },
      { domain: 'hdporn.pics', email: 'abuse@hdporn.pics' },
      { domain: 'nsfw.xxx', email: 'abuse@nsfw.xxx' },
      { domain: 'nudegirls.wiki', email: 'abuse@nudegirls.wiki' },
      { domain: 'pornpics.click', email: 'help@pornpics.click' },
      { domain: 'xpics.me', email: 'help@xpics.me' },
      { domain: 'fapezy.com', email: 'fapezyofficial@gmail.com' },
      { domain: 'fapodrop.com', email: 'abusedrop@fapodrop.com' },
      { domain: 'theasmrindex.com', email: 'info@theasmrindex.com' },
      { domain: 'fapeza.com', email: 'fapezan@gmail.com' },
      { domain: 'kemono.su', email: 'legal@kemono.su' },
      { domain: 'thefapomania.info', email: 'fapomania990@gmail.com' },
      { domain: 'nudostar.com', email: 'nudodmca@gmail.com' },
      { domain: 'rndigitalprint.pk', email: 'abuse@cutefans.win' },
      { domain: 'thefappeningblog.com', email: 'thefappeningabuses@gmail.com' },
      { domain: 'fapopedia-net.zproxy.org', email: 'johnnysinsmom@gmail.com' },
      { domain: 'fapopedia.net', email: 'johnnysinsmom@gmail.com' },
      { domain: 'nudostar.tv', email: 'johnnysinsmom@gmail.com' },
      { domain: 'topfapgirls1.com', email: 'piava@topfapgirls1.com' },
      { domain: 'faponic.com', email: 'faponic@gmail.com' },
      { domain: 'cambb.xxx', email: 'info@cambb.xxx' },
      { domain: 'emart.cl', email: 'abuse@cutefans.win' },
      { domain: 'sushikoi.mx', email: 'abuse@cutefans.win' },
      { domain: 'nudogram.com', email: 'nudogram@gmail.com' },
      { domain: 'erothots.co', email: 'erothots@proton.me' },
      { domain: 'leakedmodels.com', email: 'leakedmodmca@gmail.com' },
      { domain: 'fappeningbook.com', email: 'lopapopator@gmail.com' },
      { domain: 'thefap.org', email: 'dmca@thefap.org' },
      { domain: 'sexiezpix.com', email: 'hdpic2020@gmail.com' },
      { domain: 'thefappening.plus', email: 'johnstevensonday@gmail.com' },
      { domain: 'fapello.com', email: 'johnfapello@gmail.com' },
      { domain: 'criew.com', email: 'criewstats@gmail.com' },
      { domain: 'yufap.com', email: 'legalyufap@gmail.com' },
      { domain: 'shemaleleaks.com', email: 'shemalesdmca@gmail.com' },
      { domain: 'radio-gold.rs', email: 'abuse@cutefans.win' },
      { domain: 'a-lohas.jp', email: 'abuse@cutefans.win' },
      { domain: 'amaporn.com', email: 'dmca@amaporn.com' },
      { domain: 'ebonygalore.com', email: 'dmca@adultwebmasternet.com' },
      { domain: 'ebony8.com', email: 'dmcalegalreport@gmail.com' },
      { domain: 'exporntoons.net', email: 'abuse@exporntoons.net' },
      { domain: 'allpornimages.com', email: 'report@allpornimages.com' },
      { domain: 'analpics.org', email: 'contact@analpics.org' },
      { domain: 'asspictures.org', email: 'andrew.webm@protonmail.com' },
      { domain: 'boobspics.org', email: 'contact@boobspics.org' },
      { domain: 'freepornpicss.com', email: 'dmca@freepornpicss.com' },
      { domain: 'gfpornpictures.com', email: 'dmca@gfpornpictures.com' },
      { domain: 'givemeporn.club', email: 'mzx001@pm.me' },
      { domain: 'gonewildarchive.net', email: 'gwarchive@protonmail.com' },
      { domain: 'hdnudes.net', email: 'andrew.webm@protonmail.com' },
      { domain: 'lesbianpics.org', email: 'andrew.webm@protonmail.com' },
      { domain: 'nude-pics.net', email: 'contact@nude-pics.net' },
      { domain: 'nude-pics.org', email: 'report@nude-pics.org' },
      { domain: 'nudeteen.org', email: 'andrew.webm@protonmail.com' },
      { domain: 'nudeporn.org', email: 'andrew.webm@protonmail.com' },
      { domain: 'onlyaccounts.io', email: 'contact@onlyaccounts.io' },
      { domain: 'pornr.net', email: 'contact@pornr.net' },
      { domain: 'qckprn.com', email: 'qckprn@gmail.com' },
      { domain: 'redd.tube', email: 'copy@reddit.tube' },
      { domain: 'scrolller.com', email: 'report@scrolller.com' },
      { domain: 'sexbizlaw.com', email: 'contact@sexbizlaw.com' },
      { domain: 'sexpornpictures.com', email: 'dmca@sexpornpictures.com' },
      { domain: 'sexypictures.org', email: 'andrew.webm@protonmail.com' },
      { domain: 'sexypornpictures.org', email: 'report@sexypornpictures.org' },
      { domain: 'smutty.com', email: 'dmca@smutty.com' },
      { domain: 'super-porn.net', email: 'watchporn.net@gmail.com' },
      { domain: 'thefap.net', email: 'monster98.tk@gmail.com' },
      { domain: 'thefaphub.com', email: 'support@thefaphub.com' },
      { domain: 'watch-porn.net', email: 'watchporn.net@gmail.com' },
      { domain: 'watchporn.pics', email: 'dmca@watchporn.pics' },
      { domain: 'xxxnudes.net', email: 'andrew.webm@protonmail.com' },
      { domain: 'xxxscroll.com', email: 'info@xxxscroll.com' },
      { domain: 'xxxpornpics.net', email: 'contact@xxxpornpics.net' },
      { domain: 'fapshots.com', email: 'admin@fapshots.com' },
    ];
    for (const { domain, email } of seedData) {
      await db.upsertSiteContactEmail(domain, email);
    }
    res.json({ ok: true, message: `Seeded ${seedData.length} domain/email pairs` });
  } catch (err) {
    console.error('Admin site-emails/seed failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Usage: https://api.sentryvo.com/api/admin/send-digest-now?key=YOUR_ADMIN_KEY
// Manually triggers the consolidated admin digest (major-platform +
// Google Images items needing manual reporting, across all active users) —
// useful for testing without waiting for the daily cron. Same "only items
// not already sent" logic as the automatic version in cron.js.
app.get('/api/admin/send-digest-now', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { sendAdminDigestIfNeeded } = require('./cron');
    await sendAdminDigestIfNeeded();
    res.json({ ok: true, message: 'Digest check complete — see server logs for whether anything was actually sent' });
  } catch (err) {
    console.error('Manual digest trigger failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Admin: send a client's full report right now ----------------
// GET /api/admin/send-report?key=ADMIN_KEY&email=client@example.com[&scan=1]
// Emails the client (admin gets a copy for admin-added clients) a report with
// every link found so far. With scan=1 it runs a fresh scan for that client
// first. Returns the exact error if the email can't be sent.
app.get('/api/admin/send-report', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const user = await db.getUserByEmail(String(req.query.email || '').trim());
    if (!user) return res.status(404).json({ error: 'No client with that email' });
    if (user.status !== 'active') return res.status(400).json({ error: `Client status is "${user.status}", not active` });

    let scanResult = null;
    if (req.query.scan === '1') {
      const { runDailyScanForUser } = require('./scanner');
      scanResult = await runDailyScanForUser(user);
      if (scanResult.reportSent) return res.json({ ok: true, message: 'Scanned and report sent', scanResult });
    }

    const leaks = (await db.getAllLeaksForUser(user.id, { limit: 2000, offset: 0 })).filter((l) => l.status !== 'dismissed');
    const summary = await db.getLeakSummary(user.id);
    const { sendDailyReportEmail } = require('./emailReport');
    const mail = await sendDailyReportEmail(user, leaks, summary);
    await db.logReportSent(user.id, leaks.length);
    await db.markReportSentNow(user.id);
    res.json({ ok: true, message: `Report with ${leaks.length} link(s) handed to the mail server for ${user.email}`, mail, scanResult });
  } catch (err) {
    console.error('Admin send-report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Admin: add a client directly (e.g. a Fiverr client) ----------------
// Usage: POST https://api.sentryvo.com/api/admin/add-client?key=YOUR_ADMIN_KEY
// Body: { name, email, mobile, plan, platforms, aliases, originalLinks }
//
// Creates an account that's active IMMEDIATELY, with no Lemon Squeezy
// checkout at all — for a client who already paid you outside SentryVo
// (e.g. through a Fiverr order) and you're setting up their protection
// directly. The account gets a random, unusable password; the client
// receives a welcome email with a link to set their own real password —
// you never see or handle their actual password yourself.
app.post('/api/admin/add-client', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { name, email, mobile, plan, platforms, aliases, originalLinks } = req.body || {};

    if (!name || !email || !plan) {
      return res.status(400).json({ error: 'name, email and plan are required' });
    }
    if (!['single', 'multi'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be "single" or "multi"' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const platformList = Array.isArray(platforms) ? platforms : String(platforms || '').split(',').map((p) => p.trim()).filter(Boolean);
    if (!platformList.length) {
      return res.status(400).json({ error: 'Select at least one platform' });
    }

    // Random, unusable password — the client sets their own real one via
    // the welcome email below. Nobody (including the admin) ever knows
    // this placeholder value.
    const randomPassword = crypto.randomBytes(24).toString('hex');
    const passwordHash = bcrypt.hashSync(randomPassword, 10);

    const userId = await db.createUser({
      name,
      email,
      mobile: mobile || '',
      passwordHash,
      plan,
      platforms: platformList.join(','),
      checkoutRef: null,
      source: 'fiverr',
      status: 'active', // active immediately — no checkout webhook needed
    });

    const aliasList = Array.isArray(aliases) ? aliases : String(aliases || '').split(',').map((a) => a.trim());
    await db.addAliases(userId, aliasList.length ? aliasList : [name]);

    const linkList = Array.isArray(originalLinks) ? originalLinks : String(originalLinks || '').split('\n').map((l) => l.trim());
    await db.addOriginalLinks(userId, linkList.filter(Boolean));

    // Send the client a real, working "set your password" link — reuses
    // the same token mechanism as the forgot-password flow.
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_DURATION_MS);
    await db.createPasswordResetToken(token, userId, expiresAt);
    const siteUrl = process.env.SENTRYVO_SITE_URL || 'https://www.sentryvo.com';
    const resetUrl = `${siteUrl}/reset-password.html?token=${token}`;

    const { sendWelcomeSetPasswordEmail } = require('./emailReport');
    await sendWelcomeSetPasswordEmail(email, resetUrl, name);

    res.json({ ok: true, userId, message: `${name} added and active — a welcome email with a password-setup link was sent to ${email}` });
  } catch (err) {
    console.error('Admin add-client error:', err.message);
    res.status(500).json({ error: 'Could not create the client account. Please try again shortly.' });
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
