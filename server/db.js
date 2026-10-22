/**
 * SentryVo database layer — Postgres (via `pg`), designed for Neon's free
 * tier but works with any standard Postgres connection string.
 *
 * IMPORTANT CHANGE FROM THE OLD SQLITE VERSION: every function here now
 * returns a Promise. Anywhere the old code called `db.getUserByEmail(x)`
 * synchronously, it must now be `await db.getUserByEmail(x)`. This ripples
 * through index.js, scanner.js, and anywhere else that touches the
 * database — see those files for the corresponding `await` additions.
 *
 * Set DATABASE_URL in your .env to the connection string Neon gives you,
 * e.g. postgresql://user:pass@host/dbname?sslmode=require
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL; this accepts their cert chain
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      mobile TEXT,
      password_hash TEXT,
      plan TEXT NOT NULL,
      platforms TEXT,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      checkout_ref TEXT,
      ls_subscription_id TEXT,
      report_frequency_days INTEGER NOT NULL DEFAULT 3,
      last_report_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Agency support: an agency is a billing/roster container. The agency
    -- OWNER is just a normal row in users (role='agency_owner') — this
    -- means registration, Lemon Squeezy checkout, and the webhook
    -- activation logic all work completely unchanged for the owner. Each
    -- creator on the roster is ALSO a normal users row (role='agency_member'),
    -- linked via agency_id — so they log in and see their own dashboard
    -- exactly like an individual subscriber always has, no special cases
    -- needed in the existing dashboard/scan code.
    CREATE TABLE IF NOT EXISTS agencies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL, -- 'agency_starter' | 'agency_growth' | 'agency_enterprise'
      max_creators INTEGER, -- NULL means unlimited (Enterprise)
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS agency_id INTEGER REFERENCES agencies(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'individual';
    -- Tracks how the account was created — 'direct' (self-registered
    -- through Lemon Squeezy checkout, the normal flow) or 'fiverr' (added
    -- directly by the admin for a client who paid through Fiverr instead).
    -- Purely for the admin's own reference — doesn't change how the
    -- account behaves once active.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'direct';
    -- Admin-added (Fiverr) clients always get a report every day.
    UPDATE users SET report_frequency_days = 1 WHERE source = 'fiverr' AND report_frequency_days <> 1;
    -- Lemon Squeezy's own "manage your subscription" portal link — captured
    -- from the webhook payload when present (subscription events include
    -- data.attributes.urls.customer_portal). Powers the dashboard's Billing
    -- tab; older accounts activated before this existed will just have NULL
    -- here, handled gracefully on the frontend with a fallback message.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ls_customer_portal_url TEXT;
    -- role is one of: 'individual' (existing single/multi subscribers, unaffected),
    -- 'agency_owner' (manages a roster, billed via Lemon Squeezy like before),
    -- 'agency_member' (a creator added by an agency owner, no separate billing)

    CREATE TABLE IF NOT EXISTS aliases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS original_links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leaks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT,
      source TEXT,
      matched_alias TEXT,
      platform_hint TEXT,
      hosting_provider TEXT,
      status TEXT NOT NULL DEFAULT 'found',
      found_at TIMESTAMPTZ DEFAULT NOW(),
      reported_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      UNIQUE(user_id, url)
    );

    -- Tracks whether a leak needing manual action (major-platform or
    -- Google Images) has already been included in an admin digest email —
    -- without this, the same still-open item would get re-sent every
    -- single day forever. NULL means "not yet surfaced to the admin."
    ALTER TABLE leaks ADD COLUMN IF NOT EXISTS admin_digest_sent_at TIMESTAMPTZ;

    -- Google's result snippet, kept so a leak can be re-checked for alias
    -- relevance later. Leaks that fail that check get status 'dismissed'
    -- and are excluded from reports, dashboards and takedown notices.
    ALTER TABLE leaks ADD COLUMN IF NOT EXISTS snippet TEXT;

    -- Set when an image found online matched one of the client's original
    -- photos by content fingerprint (value = number of differing bits out of
    -- 64; lower is closer). Such leaks are verified by the image itself, so
    -- they are exempt from the alias-in-text relevance check.
    ALTER TABLE leaks ADD COLUMN IF NOT EXISTS fingerprint_distance INTEGER;

    -- When this leak's page was exported and submitted to Google's removal
    -- (delisting) form, so the next export only contains new links.
    ALTER TABLE leaks ADD COLUMN IF NOT EXISTS google_submitted_at TIMESTAMPTZ;

    -- Perceptual hashes of a client's ORIGINAL photos (never the images
    -- themselves). Used to recognise re-uploads of the same photo.
    CREATE TABLE IF NOT EXISTS content_fingerprints (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, hash)
    );

    CREATE TABLE IF NOT EXISTS reports_sent (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      new_leaks_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    -- Forgot-password flow: a short-lived, single-use token emailed to the
    -- account holder. Separate from sessions on purpose — a reset token
    -- proves "I clicked the email link," not "I'm currently logged in," and
    -- expires much sooner (1 hour vs 30 days).
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    -- Manually-verified domain -> email lookup for takedown notices. Checked
    -- FIRST, before the page-scrape or RDAP fallbacks in scanner.js — these
    -- are human-confirmed working contacts, more trustworthy than anything
    -- a script could infer automatically. Manageable via the
    -- /api/admin/site-emails/* endpoints in index.js.
    CREATE TABLE IF NOT EXISTS site_contact_emails (
      domain TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- One free homepage scan per visitor, for life. visitor_hash is a
    -- salted SHA-256 of the visitor's IP address (see index.js) — the raw
    -- IP is never stored.
    -- Scan scheduling: the cron checks every hour and scans each client
    -- whose plan interval has passed since last_scan_at (see scanner.js).
    -- last_lens_at limits the reverse image search to once a day.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lens_at TIMESTAMPTZ;
    -- Lemon Squeezy's own subscription status ('active', 'cancelled',
    -- 'past_due', 'expired', ...) and, for a cancelled subscription, the
    -- date its paid period ends. users.status is what the scanner obeys.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ls_subscription_status TEXT;
    -- Sales partner (Lemon Squeezy affiliate) code the client signed up with.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;

    -- Public URLs of a client's own photos, searched with Google Lens to
    -- find re-uploads that don't mention their name. Only the URL is kept.
    CREATE TABLE IF NOT EXISTS reference_images (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, url)
    );

    CREATE TABLE IF NOT EXISTS free_scans (
      visitor_hash TEXT PRIMARY KEY,
      alias TEXT,
      scanned_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Small key/value store for scheduler state that must survive restarts
    -- (e.g. the day the admin's daily email was last sent).
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Fake accounts (impersonation.js). One row per client, platform and
    -- username. status: pending (admin only) -> confirmed -> reported ->
    -- removed; or dismissed (not fake) / official (the client's own).
    CREATE TABLE IF NOT EXISTS impersonations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      reason TEXT,
      fingerprint_distance INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      found_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      reported_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      report_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, platform, handle)
    );

    -- The client's own accounts on big platforms, so they're never flagged
    -- as fake. Kept apart from original_links on purpose: an original link
    -- covers its whole site for the leak scan, which would hide every leak
    -- on instagram.com just because the client's own Instagram was added.
    CREATE TABLE IF NOT EXISTS official_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      url TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, platform, handle)
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_impersonation_at TIMESTAMPTZ;
  `);

  // Big-platform links (status 'manual_review') are shown to the client only
  // after the admin approves them from the daily digest; approved_at is that
  // moment. The first time this column is added, links the client could
  // already see are marked approved so nothing they saw disappears.
  const hadApproval = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'leaks' AND column_name = 'approved_at'`
  );
  await pool.query(`ALTER TABLE leaks ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  if (!hadApproval.rows.length) {
    await pool.query(`UPDATE leaks SET approved_at = found_at WHERE status = 'manual_review'`);
  }
}

// What the client sees (reports, dashboard, counts): everything except
// dismissed links and big-platform links still waiting for approval.
const CLIENT_VISIBLE = `status <> 'dismissed' AND NOT (status = 'manual_review' AND approved_at IS NULL)`;

// Run once at startup; index.js awaits this before accepting requests.
const ready = initSchema();

// ---------- Agencies ----------
const AGENCY_TIER_LIMITS = {
  agency_starter: 5,
  agency_growth: 15,
  agency_enterprise: null, // unlimited
};

async function createAgency({ name, tier }) {
  const maxCreators = AGENCY_TIER_LIMITS[tier] ?? null;
  const result = await pool.query(
    `INSERT INTO agencies (name, tier, max_creators) VALUES ($1, $2, $3) RETURNING id`,
    [name, tier, maxCreators]
  );
  return result.rows[0].id;
}

async function getAgencyById(id) {
  const result = await pool.query(`SELECT * FROM agencies WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getAgencyOwner(agencyId) {
  const result = await pool.query(
    `SELECT * FROM users WHERE agency_id = $1 AND role = 'agency_owner'`,
    [agencyId]
  );
  return result.rows[0] || null;
}

async function getAgencyMembers(agencyId) {
  const result = await pool.query(
    `SELECT * FROM users WHERE agency_id = $1 AND role = 'agency_member' ORDER BY created_at ASC`,
    [agencyId]
  );
  return result.rows;
}

async function countAgencyMembers(agencyId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM users WHERE agency_id = $1 AND role = 'agency_member'`,
    [agencyId]
  );
  return Number(result.rows[0].count);
}

// ---------- Users ----------
async function createUser({ name, email, mobile, passwordHash, plan, platforms, checkoutRef, agencyId = null, role = 'individual', source = 'direct', status = null }) {
  const reportFrequencyDays = plan === 'multi' || source === 'fiverr' ? 1 : 3;
  // Explicit status wins if given (used for admin-added Fiverr clients, who
  // are active immediately with no Lemon Squeezy checkout at all) —
  // otherwise falls back to the existing rule: agency members are active
  // immediately since the agency already pays, everyone else starts
  // pending_payment until their checkout webhook fires.
  const resolvedStatus = status || (role === 'agency_member' ? 'active' : 'pending_payment');
  const result = await pool.query(
    `INSERT INTO users (name, email, mobile, password_hash, plan, platforms, checkout_ref, report_frequency_days, status, agency_id, role, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [name, email, mobile, passwordHash, plan, platforms, checkoutRef, reportFrequencyDays, resolvedStatus, agencyId, role, source]
  );
  return result.rows[0].id;
}

async function setUserActiveByCheckoutRef(checkoutRef, lsSubscriptionId) {
  await pool.query(
    `UPDATE users SET status = 'active', ls_subscription_id = COALESCE($1, ls_subscription_id) WHERE checkout_ref = $2`,
    [lsSubscriptionId || null, checkoutRef]
  );
}

async function setUserCheckoutRef(userId, checkoutRef) {
  await pool.query(`UPDATE users SET checkout_ref = $1 WHERE id = $2`, [checkoutRef, userId]);
}

async function getUserByCheckoutRef(checkoutRef) {
  const result = await pool.query(`SELECT * FROM users WHERE checkout_ref = $1`, [checkoutRef]);
  return result.rows[0] || null;
}

async function getUserBySubscriptionId(subscriptionId) {
  const result = await pool.query(`SELECT * FROM users WHERE ls_subscription_id = $1`, [subscriptionId]);
  return result.rows[0] || null;
}

// Applies a Lemon Squeezy subscription change to one account.
async function setSubscriptionState(userId, { status, lsStatus, endsAt, subscriptionId }) {
  await pool.query(
    `UPDATE users
        SET status = $1,
            ls_subscription_status = $2,
            subscription_ends_at = $3,
            ls_subscription_id = COALESCE($4, ls_subscription_id)
      WHERE id = $5`,
    [status, lsStatus, endsAt || null, subscriptionId || null, userId]
  );
}

// When an agency's own subscription stops, its creators stop too; when it
// comes back, creators that were paused because of it come back with it.
async function setAgencyMembersStatus(agencyId, status) {
  const from = status === 'active' ? ['expired', 'paused'] : ['active'];
  await pool.query(
    `UPDATE users SET status = $1 WHERE agency_id = $2 AND role = 'agency_member' AND status = ANY($3::text[])`,
    [status, agencyId, from]
  );
}

async function setUserReferralCode(userId, code) {
  await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, userId]);
}

async function markScanStarted(userId) {
  await pool.query(`UPDATE users SET last_scan_at = NOW() WHERE id = $1`, [userId]);
}

async function markLensRun(userId) {
  await pool.query(`UPDATE users SET last_lens_at = NOW() WHERE id = $1`, [userId]);
}

// ---------- Reference images (reverse image search) ----------
const MAX_REFERENCE_IMAGES_PER_USER = 30;

async function addReferenceImage(userId, url) {
  const count = await pool.query(`SELECT COUNT(*) AS n FROM reference_images WHERE user_id = $1`, [userId]);
  if (Number(count.rows[0].n) >= MAX_REFERENCE_IMAGES_PER_USER) return 'limit';
  const result = await pool.query(
    `INSERT INTO reference_images (user_id, url) VALUES ($1, $2) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
    [userId, url]
  );
  return result.rowCount ? 'added' : 'exists';
}

async function getReferenceImages(userId) {
  const result = await pool.query(`SELECT url FROM reference_images WHERE user_id = $1 ORDER BY id ASC`, [userId]);
  return result.rows.map((r) => r.url);
}

async function clearReferenceImages(userId) {
  const result = await pool.query(`DELETE FROM reference_images WHERE user_id = $1`, [userId]);
  return result.rowCount;
}

async function getUserById(id) {
  const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getActiveUsers() {
  const result = await pool.query(`SELECT * FROM users WHERE status = 'active'`);
  return result.rows;
}

async function getUserByEmail(email) {
  const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return result.rows[0] || null;
}

async function markReportSentNow(userId) {
  await pool.query(`UPDATE users SET last_report_at = NOW() WHERE id = $1`, [userId]);
}

// A report is due on its calendar day: report_frequency_days after the last
// one, from REPORT_HOUR local time (see constants.js). Counting calendar days
// keeps reports at the same time every day; the old "24 hours after the last
// one" rule made the time drift with every scan or manual send. A report that
// is a day or more late goes out at the next check, whatever the hour.
function isReportDue(user, now = new Date()) {
  if (!user.last_report_at) return true;
  const { localTime, REPORT_HOUR } = require('./constants');
  const today = localTime(now);
  const daysSince = today.day - localTime(user.last_report_at).day;
  const every = Math.max(1, Number(user.report_frequency_days) || 1);
  if (daysSince < every) return false;
  return daysSince > every || today.hour >= REPORT_HOUR;
}

// ---------- Sessions (simple token-based auth) ----------
// ---------- Free scans (one per visitor) ----------
// Atomic claim: returns true only for the first request from this visitor,
// so two simultaneous requests can't both get a free scan.
async function claimFreeScan(visitorHash, alias) {
  const result = await pool.query(
    `INSERT INTO free_scans (visitor_hash, alias) VALUES ($1, $2)
     ON CONFLICT (visitor_hash) DO NOTHING
     RETURNING visitor_hash`,
    [visitorHash, alias]
  );
  return result.rowCount === 1;
}

// Gives the visitor their free scan back when the scan itself failed on our
// side (e.g. Serper.dev down) — they shouldn't lose it to our outage.
async function releaseFreeScan(visitorHash) {
  await pool.query(`DELETE FROM free_scans WHERE visitor_hash = $1`, [visitorHash]);
}

async function createSession(token, userId, expiresAt) {
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );
}

async function getSession(token) {
  const result = await pool.query(
    `SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

async function deleteSession(token) {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// ---------- Password reset tokens ----------
async function createPasswordResetToken(token, userId, expiresAt) {
  await pool.query(
    `INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );
}

async function getPasswordResetToken(token) {
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

async function deletePasswordResetToken(token) {
  await pool.query(`DELETE FROM password_reset_tokens WHERE token = $1`, [token]);
}

// ---------- Manually-verified site contact emails ----------
async function getSiteContactEmail(domain) {
  const result = await pool.query(`SELECT * FROM site_contact_emails WHERE domain = $1`, [domain]);
  return result.rows[0] || null;
}

async function upsertSiteContactEmail(domain, email) {
  await pool.query(
    `INSERT INTO site_contact_emails (domain, email, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (domain) DO UPDATE SET email = $2, updated_at = NOW()`,
    [domain, email]
  );
}

async function deleteSiteContactEmail(domain) {
  await pool.query(`DELETE FROM site_contact_emails WHERE domain = $1`, [domain]);
}

// Leak-site domains worth targeting with site: queries — the ones that have
// produced the most (non-dismissed) leaks across all clients first, then
// every domain in the verified contact list. Returns plain lowercase domains.
async function getLeakSiteDomains(limit = 100) {
  const seen = new Map();
  const fromLeaks = await pool.query(
    `SELECT d AS domain, COUNT(*)::int AS n
     FROM (
       SELECT lower(regexp_replace(substring(url from '^https?://([^/:?#]+)'), '^www[.]', '')) AS d
       FROM leaks WHERE status <> 'dismissed'
     ) t
     WHERE d IS NOT NULL
     GROUP BY d ORDER BY n DESC LIMIT $1`,
    [limit]
  );
  fromLeaks.rows.forEach((r) => r.domain && seen.set(r.domain, r.n));
  const fromContacts = await pool.query(`SELECT lower(domain) AS domain FROM site_contact_emails`);
  fromContacts.rows.forEach((r) => {
    if (r.domain && !seen.has(r.domain)) seen.set(r.domain, 0);
  });
  return Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain)
    .slice(0, limit);
}

async function listSiteContactEmails() {
  const result = await pool.query(`SELECT * FROM site_contact_emails ORDER BY domain ASC`);
  return result.rows;
}

// ---------- Aliases ----------
async function addAliases(userId, aliasList) {
  const clean = aliasList.filter(Boolean);
  for (const alias of clean) {
    await pool.query(`INSERT INTO aliases (user_id, alias) VALUES ($1, $2)`, [userId, alias.trim()]);
  }
}

async function getAliasesForUser(userId) {
  const result = await pool.query(`SELECT alias FROM aliases WHERE user_id = $1`, [userId]);
  return result.rows.map((r) => r.alias);
}

// Wipes a user's existing aliases and replaces them with a fresh list — for
// fixing aliases that were entered wrong (e.g. full phrases like "kitsykat
// nude" instead of just "kitsykat"), not for routine additions. Runs inside
// a transaction so a failed insert can't leave the user with zero aliases.
async function replaceAliases(userId, aliasList) {
  const clean = [...new Set(aliasList.map((a) => a.trim()).filter(Boolean))];
  if (!clean.length) throw new Error('At least one alias is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM aliases WHERE user_id = $1`, [userId]);
    for (const alias of clean) {
      await client.query(`INSERT INTO aliases (user_id, alias) VALUES ($1, $2)`, [userId, alias]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return clean;
}

// ---------- Original content links (proof of ownership, NOT infringing links) ----------
async function addOriginalLinks(userId, urlList) {
  const clean = urlList.filter(Boolean);
  for (const url of clean) {
    await pool.query(`INSERT INTO original_links (user_id, url) VALUES ($1, $2)`, [userId, url.trim()]);
  }
}

// ---------- Content fingerprints ----------
const MAX_FINGERPRINTS_PER_USER = 300;

async function addFingerprint(userId, hash) {
  const count = await countFingerprints(userId);
  if (count >= MAX_FINGERPRINTS_PER_USER) return 'limit';
  const result = await pool.query(
    `INSERT INTO content_fingerprints (user_id, hash) VALUES ($1, $2)
     ON CONFLICT (user_id, hash) DO NOTHING RETURNING id`,
    [userId, hash]
  );
  return result.rows.length ? 'added' : 'duplicate';
}

async function countFingerprints(userId) {
  const result = await pool.query(`SELECT COUNT(*)::int AS n FROM content_fingerprints WHERE user_id = $1`, [userId]);
  return result.rows[0].n;
}

async function getFingerprintsForUser(userId) {
  const result = await pool.query(`SELECT hash FROM content_fingerprints WHERE user_id = $1`, [userId]);
  return result.rows.map((r) => r.hash);
}

async function clearFingerprints(userId) {
  const result = await pool.query(`DELETE FROM content_fingerprints WHERE user_id = $1`, [userId]);
  return result.rowCount;
}

async function getOriginalLinksForUser(userId) {
  const result = await pool.query(`SELECT url FROM original_links WHERE user_id = $1`, [userId]);
  return result.rows.map((r) => r.url);
}

// ---------- Leaks ----------
async function leakExists(userId, url) {
  const result = await pool.query(`SELECT 1 FROM leaks WHERE user_id = $1 AND url = $2`, [userId, url]);
  return result.rows.length > 0;
}

async function insertLeak({ userId, url, title, source, matchedAlias, snippet = null, fingerprintDistance = null }) {
  // ON CONFLICT ... DO UPDATE (a harmless no-op update) instead of DO
  // NOTHING specifically so RETURNING always gives back a row — callers
  // that need the leak's id and current status (e.g. building a
  // consolidated takedown notice, which should skip anything already
  // reported/removed in a previous scan rather than re-notifying it) get
  // both, whether this was a fresh insert or the leak already existed.
  const result = await pool.query(
    `INSERT INTO leaks (user_id, url, title, source, matched_alias, snippet, fingerprint_distance, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'found')
     ON CONFLICT (user_id, url) DO UPDATE SET url = EXCLUDED.url
     RETURNING id, status`,
    [userId, url, title, source, matchedAlias, snippet, fingerprintDistance]
  );
  return result.rows[0];
}

async function getLeaksFoundSince(userId, isoTimestamp) {
  const result = await pool.query(
    // A big-platform link approved since the last report counts as new.
    `SELECT * FROM leaks WHERE user_id = $1 AND (found_at >= $2 OR approved_at >= $2) AND ${CLIENT_VISIBLE} ORDER BY found_at DESC`,
    [userId, isoTimestamp]
  );
  return result.rows;
}

async function getLeaksByStatus(userId, status) {
  const result = await pool.query(`SELECT * FROM leaks WHERE user_id = $1 AND status = $2`, [userId, status]);
  return result.rows;
}

// includeUnapproved: admin views also list big-platform links still
// waiting for approval; the client's dashboard and reports never do.
async function getAllLeaksForUser(userId, { limit = 100, offset = 0, includeUnapproved = false } = {}) {
  const result = await pool.query(
    `SELECT * FROM leaks WHERE user_id = $1 AND ${includeUnapproved ? `status <> 'dismissed'` : CLIENT_VISIBLE} ORDER BY found_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
}

// Leaks still worth asking Google to delist: not removed, not dismissed, and
// (unless includeSubmitted) not already exported for Google.
async function getLeaksForGoogleDelist(userId, { includeSubmitted = false } = {}) {
  const result = await pool.query(
    `SELECT id, url, title, source, snippet, found_at FROM leaks
     WHERE user_id = $1 AND status NOT IN ('removed', 'dismissed')
       AND ($2::boolean OR google_submitted_at IS NULL)
     ORDER BY found_at ASC`,
    [userId, includeSubmitted]
  );
  return result.rows;
}

async function markGoogleSubmitted(userId, leakIds) {
  if (!leakIds.length) return 0;
  const result = await pool.query(
    `UPDATE leaks SET google_submitted_at = NOW() WHERE user_id = $1 AND id = ANY($2::int[])`,
    [userId, leakIds]
  );
  return result.rowCount;
}

async function markLeakStatus(id, status) {
  const column = status === 'reported' ? 'reported_at' : status === 'removed' ? 'removed_at' : null;
  if (column) {
    await pool.query(`UPDATE leaks SET status = $1, ${column} = NOW() WHERE id = $2`, [status, id]);
  } else {
    await pool.query(`UPDATE leaks SET status = $1 WHERE id = $2`, [status, id]);
  }
}

async function setLeakHostingProvider(id, hostingProvider) {
  if (!hostingProvider) return;
  await pool.query(`UPDATE leaks SET hosting_provider = $1 WHERE id = $2`, [hostingProvider, id]);
}

async function getLeakSummary(userId) {
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'found' THEN 1 ELSE 0 END) AS found,
       SUM(CASE WHEN status = 'reported' THEN 1 ELSE 0 END) AS reported,
       SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed
     FROM leaks WHERE user_id = $1 AND ${CLIENT_VISIBLE}`,
    [userId]
  );
  const row = result.rows[0];
  // Postgres COUNT/SUM return strings for bigint — convert to numbers for the frontend
  return {
    total: Number(row.total) || 0,
    found: Number(row.found) || 0,
    reported: Number(row.reported) || 0,
    removed: Number(row.removed) || 0,
  };
}

async function logReportSent(userId, newLeaksCount) {
  await pool.query(`INSERT INTO reports_sent (user_id, new_leaks_count) VALUES ($1, $2)`, [userId, newLeaksCount]);
}

// ---------- Admin digest (consolidated manual-review items, across ALL active users) ----------
// Two categories, both "not yet surfaced" (admin_digest_sent_at IS NULL):
//   - status = 'manual_review'  -> major-platform leaks (any source)
//   - source = 'serper_image'   -> generic-site image leaks needing a
//                                  separate Google Images delisting request
// A major-platform image leak matches the first condition (status is set
// to 'manual_review' regardless of source for those), so it's correctly
// classified as a platform item, not double-counted as a Google Images
// item too — the caller distinguishes the two by checking `status` first.
async function getPendingAdminDigestLeaks({ includeSent = false } = {}) {
  // Everything the admin has to report by hand: major-platform leaks (own
  // forms) and every page/image result found through Google Search or Google
  // Images (to request delisting from Google). Raw CDN media files found by
  // page crawling are not indexed pages, so they are left out.
  const result = await pool.query(`
    SELECT leaks.*, users.name AS creator_name, users.email AS creator_email
    FROM leaks
    JOIN users ON users.id = leaks.user_id
    WHERE ($1::boolean OR leaks.admin_digest_sent_at IS NULL
           -- big-platform links waiting for approval are repeated daily until decided
           OR (leaks.status = 'manual_review' AND leaks.approved_at IS NULL))
      AND ($1::boolean = false OR leaks.google_submitted_at IS NULL)
      AND leaks.status NOT IN ('dismissed', 'removed')
      AND (leaks.status = 'manual_review' OR leaks.source IN ('serper_web', 'serper_image', 'serper_lens', 'search_expand'))
    ORDER BY leaks.found_at ASC
  `, [includeSent]);
  return result.rows;
}

async function getAppState(key) {
  const result = await pool.query(`SELECT value FROM app_state WHERE key = $1`, [key]);
  return result.rows[0]?.value ?? null;
}

async function setAppState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  );
}

async function countLeaksSince(userId, isoTimestamp) {
  const result = await pool.query(
    `SELECT COUNT(*) AS n FROM leaks WHERE user_id = $1 AND found_at >= $2 AND status <> 'dismissed'`,
    [userId, isoTimestamp]
  );
  return Number(result.rows[0].n) || 0;
}

async function getLeakById(id) {
  const result = await pool.query(`SELECT * FROM leaks WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

// Admin approved a big-platform link: the client sees it from now on.
async function approveLeak(id) {
  await pool.query(`UPDATE leaks SET approved_at = NOW() WHERE id = $1 AND approved_at IS NULL`, [id]);
}

async function markLeaksDigestSent(leakIds) {
  if (!leakIds.length) return;
  await pool.query(`UPDATE leaks SET admin_digest_sent_at = NOW() WHERE id = ANY($1::int[])`, [leakIds]);
}

// ---------- Fake accounts (impersonation) ----------
// What the client sees: accounts the admin confirmed as fake.
const IMPERSONATION_CLIENT_VISIBLE = ['confirmed', 'reported', 'removed'];

async function insertImpersonation({ userId, platform, handle, url, title, reason, fingerprintDistance = null }) {
  const result = await pool.query(
    `INSERT INTO impersonations (user_id, platform, handle, url, title, reason, fingerprint_distance)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, platform, handle) DO NOTHING RETURNING id`,
    [userId, platform, handle, url, title, reason, fingerprintDistance]
  );
  return result.rows[0] || null;
}

async function countImpersonations(userId) {
  const result = await pool.query(`SELECT COUNT(*)::int AS n FROM impersonations WHERE user_id = $1`, [userId]);
  return result.rows[0].n;
}

async function getImpersonationById(id) {
  const result = await pool.query(`SELECT * FROM impersonations WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function getImpersonationsByStatus(userId, statuses) {
  const result = await pool.query(
    `SELECT * FROM impersonations WHERE user_id = $1 AND status = ANY($2::text[]) ORDER BY found_at ASC`,
    [userId, statuses]
  );
  return result.rows;
}

// includeAll: admin view (every status); otherwise only what the client sees.
async function getImpersonationsForUser(userId, { includeAll = false } = {}) {
  const result = await pool.query(
    `SELECT * FROM impersonations WHERE user_id = $1 AND ($2::boolean OR status = ANY($3::text[])) ORDER BY found_at DESC`,
    [userId, includeAll, IMPERSONATION_CLIENT_VISIBLE]
  );
  return result.rows;
}

// Confirmed since the last report, or gone since then, for the report email.
async function getImpersonationUpdatesSince(userId, isoTimestamp) {
  const result = await pool.query(
    `SELECT * FROM impersonations WHERE user_id = $1 AND status = ANY($3::text[])
       AND (confirmed_at >= $2 OR removed_at >= $2) ORDER BY found_at DESC`,
    [userId, isoTimestamp, IMPERSONATION_CLIENT_VISIBLE]
  );
  return result.rows;
}

async function setImpersonationStatus(id, status) {
  const stamp = { confirmed: 'confirmed_at', removed: 'removed_at' }[status];
  if (status === 'reported') {
    await pool.query(`UPDATE impersonations SET status = 'reported', reported_at = NOW(), report_count = report_count + 1 WHERE id = $1`, [id]);
  } else if (stamp) {
    await pool.query(`UPDATE impersonations SET status = $1, ${stamp} = NOW() WHERE id = $2`, [status, id]);
  } else {
    await pool.query(`UPDATE impersonations SET status = $1 WHERE id = $2`, [status, id]);
  }
}

// For the admin digest, repeated daily until handled: accounts waiting for
// review, confirmed ones not yet reported, and reported ones still up after
// rereportDays (to report again).
async function getImpersonationsForDigest(rereportDays) {
  const result = await pool.query(`
    SELECT impersonations.*, users.name AS creator_name, users.email AS creator_email
    FROM impersonations JOIN users ON users.id = impersonations.user_id
    WHERE users.status = 'active'
      AND (impersonations.status IN ('pending', 'confirmed')
           OR (impersonations.status = 'reported' AND impersonations.reported_at < NOW() - make_interval(days => $1::int)))
    ORDER BY impersonations.found_at ASC
  `, [rereportDays]);
  return result.rows;
}

async function markImpersonationRun(userId) {
  await pool.query(`UPDATE users SET last_impersonation_at = NOW() WHERE id = $1`, [userId]);
}

async function addOfficialAccount(userId, { platform, handle, url }) {
  const result = await pool.query(
    `INSERT INTO official_accounts (user_id, platform, handle, url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, platform, handle) DO NOTHING RETURNING id`,
    [userId, platform, handle.toLowerCase(), url]
  );
  // Anything already flagged for this account is the client's own.
  await pool.query(
    `UPDATE impersonations SET status = 'official' WHERE user_id = $1 AND platform = $2 AND lower(handle) = lower($3)`,
    [userId, platform, handle]
  );
  return result.rowCount ? 'added' : 'exists';
}

async function getOfficialAccounts(userId) {
  const result = await pool.query(`SELECT platform, handle, url FROM official_accounts WHERE user_id = $1 ORDER BY id ASC`, [userId]);
  return result.rows;
}

// ---------- Admin: find and deactivate an account ----------
// Used by the emergency admin endpoints in index.js — lets you look up an
// account by alias or email through a browser, and immediately stop it
// from being included in any future scan, without needing direct database
// access or a separate admin panel.
async function findUsersByAliasOrEmail(searchTerm) {
  const result = await pool.query(
    `SELECT DISTINCT u.id, u.name, u.email, u.status, u.plan, u.platforms, u.source, u.created_at,
            array_agg(DISTINCT a.alias) AS aliases
     FROM users u
     LEFT JOIN aliases a ON a.user_id = u.id
     WHERE u.email ILIKE $1
        OR u.id IN (SELECT user_id FROM aliases WHERE alias ILIKE $1)
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [`%${searchTerm}%`]
  );
  return result.rows;
}

async function setUserStatus(userId, status) {
  await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
}

// Permanently removes a user row. Every related table (aliases,
// original_links, leaks, reports_sent, sessions) was created with
// "ON DELETE CASCADE" against users(id), so this one query also removes
// every trace of that user's data automatically — no separate cleanup
// queries needed. This is IRREVERSIBLE — there is no undo.
async function deleteUser(userId) {
  const result = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING email`, [userId]);
  return result.rows[0] || null;
}

// Resets a user's password to a new one you provide. Takes an already-hashed
// password (index.js hashes it with bcrypt before calling this) — this
// function never sees or stores a plain-text password itself.
async function setUserPasswordHash(userId, passwordHash) {
  const result = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email`,
    [passwordHash, userId]
  );
  return result.rows[0] || null;
}

async function setCustomerPortalUrl(userId, url) {
  await pool.query(`UPDATE users SET ls_customer_portal_url = $1 WHERE id = $2`, [url, userId]);
}

module.exports = {
  pool,
  ready,
  createUser,
  setUserActiveByCheckoutRef,
  setUserCheckoutRef,
  getUserById,
  getUserByCheckoutRef,
  getUserBySubscriptionId,
  setSubscriptionState,
  setAgencyMembersStatus,
  setUserReferralCode,
  markScanStarted,
  markLensRun,
  addReferenceImage,
  getReferenceImages,
  clearReferenceImages,
  MAX_REFERENCE_IMAGES_PER_USER,
  getActiveUsers,
  getUserByEmail,
  markReportSentNow,
  isReportDue,
  getLeakById,
  approveLeak,
  getAppState,
  setAppState,
  countLeaksSince,
  claimFreeScan,
  releaseFreeScan,
  createSession,
  getSession,
  deleteSession,
  createPasswordResetToken,
  getPasswordResetToken,
  deletePasswordResetToken,
  getSiteContactEmail,
  upsertSiteContactEmail,
  deleteSiteContactEmail,
  listSiteContactEmails,
  getLeakSiteDomains,
  addAliases,
  replaceAliases,
  getAliasesForUser,
  addOriginalLinks,
  getOriginalLinksForUser,
  leakExists,
  insertLeak,
  getLeaksFoundSince,
  addFingerprint,
  countFingerprints,
  getFingerprintsForUser,
  clearFingerprints,
  MAX_FINGERPRINTS_PER_USER,
  getLeaksByStatus,
  getAllLeaksForUser,
  markLeakStatus,
  getLeaksForGoogleDelist,
  markGoogleSubmitted,
  setLeakHostingProvider,
  getLeakSummary,
  logReportSent,
  getPendingAdminDigestLeaks,
  markLeaksDigestSent,
  findUsersByAliasOrEmail,
  setUserStatus,
  deleteUser,
  setUserPasswordHash,
  setCustomerPortalUrl,
  createAgency,
  getAgencyById,
  getAgencyOwner,
  getAgencyMembers,
  countAgencyMembers,
  insertImpersonation,
  countImpersonations,
  getImpersonationById,
  getImpersonationsByStatus,
  getImpersonationsForUser,
  getImpersonationUpdatesSince,
  setImpersonationStatus,
  getImpersonationsForDigest,
  markImpersonationRun,
  addOfficialAccount,
  getOfficialAccounts,
};
