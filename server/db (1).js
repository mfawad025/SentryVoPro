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
  `);
}
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
async function createUser({ name, email, mobile, passwordHash, plan, platforms, checkoutRef, agencyId = null, role = 'individual' }) {
  const reportFrequencyDays = plan === 'multi' ? 1 : 3;
  const result = await pool.query(
    `INSERT INTO users (name, email, mobile, password_hash, plan, platforms, checkout_ref, report_frequency_days, status, agency_id, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      name, email, mobile, passwordHash, plan, platforms, checkoutRef, reportFrequencyDays,
      role === 'agency_member' ? 'active' : 'pending_payment', // members are active immediately, the agency (owner) already pays
      agencyId,
      role,
    ]
  );
  return result.rows[0].id;
}

async function setUserActiveByCheckoutRef(checkoutRef, lsSubscriptionId) {
  await pool.query(
    `UPDATE users SET status = 'active', ls_subscription_id = $1 WHERE checkout_ref = $2`,
    [lsSubscriptionId || null, checkoutRef]
  );
}

async function setUserCheckoutRef(userId, checkoutRef) {
  await pool.query(`UPDATE users SET checkout_ref = $1 WHERE id = $2`, [checkoutRef, userId]);
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

function isReportDue(user) {
  if (!user.last_report_at) return true;
  const last = new Date(user.last_report_at).getTime();
  const dueAt = last + user.report_frequency_days * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// ---------- Sessions (simple token-based auth) ----------
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

// ---------- Original content links (proof of ownership, NOT infringing links) ----------
async function addOriginalLinks(userId, urlList) {
  const clean = urlList.filter(Boolean);
  for (const url of clean) {
    await pool.query(`INSERT INTO original_links (user_id, url) VALUES ($1, $2)`, [userId, url.trim()]);
  }
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

async function insertLeak({ userId, url, title, source, matchedAlias }) {
  await pool.query(
    `INSERT INTO leaks (user_id, url, title, source, matched_alias, status)
     VALUES ($1, $2, $3, $4, $5, 'found')
     ON CONFLICT (user_id, url) DO NOTHING`,
    [userId, url, title, source, matchedAlias]
  );
}

async function getLeaksFoundSince(userId, isoTimestamp) {
  const result = await pool.query(
    `SELECT * FROM leaks WHERE user_id = $1 AND found_at >= $2 ORDER BY found_at DESC`,
    [userId, isoTimestamp]
  );
  return result.rows;
}

async function getLeaksByStatus(userId, status) {
  const result = await pool.query(`SELECT * FROM leaks WHERE user_id = $1 AND status = $2`, [userId, status]);
  return result.rows;
}

async function getAllLeaksForUser(userId, { limit = 100, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT * FROM leaks WHERE user_id = $1 ORDER BY found_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
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
     FROM leaks WHERE user_id = $1`,
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

// ---------- Admin: find and deactivate an account ----------
// Used by the emergency admin endpoints in index.js — lets you look up an
// account by alias or email through a browser, and immediately stop it
// from being included in any future scan, without needing direct database
// access or a separate admin panel.
async function findUsersByAliasOrEmail(searchTerm) {
  const result = await pool.query(
    `SELECT DISTINCT u.id, u.name, u.email, u.status, u.plan, u.platforms, u.created_at,
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

module.exports = {
  pool,
  ready,
  createUser,
  setUserActiveByCheckoutRef,
  setUserCheckoutRef,
  getUserById,
  getActiveUsers,
  getUserByEmail,
  markReportSentNow,
  isReportDue,
  createSession,
  getSession,
  deleteSession,
  addAliases,
  getAliasesForUser,
  addOriginalLinks,
  getOriginalLinksForUser,
  leakExists,
  insertLeak,
  getLeaksFoundSince,
  getLeaksByStatus,
  getAllLeaksForUser,
  markLeakStatus,
  setLeakHostingProvider,
  getLeakSummary,
  logReportSent,
  findUsersByAliasOrEmail,
  setUserStatus,
  createAgency,
  getAgencyById,
  getAgencyOwner,
  getAgencyMembers,
  countAgencyMembers,
};
