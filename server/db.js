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

// ---------- Users ----------
async function createUser({ name, email, mobile, passwordHash, plan, platforms, checkoutRef }) {
  const reportFrequencyDays = plan === 'multi' ? 1 : 3;
  const result = await pool.query(
    `INSERT INTO users (name, email, mobile, password_hash, plan, platforms, checkout_ref, report_frequency_days, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_payment')
     RETURNING id`,
    [name, email, mobile, passwordHash, plan, platforms, checkoutRef, reportFrequencyDays]
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
};
