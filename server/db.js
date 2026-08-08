/**
 * SentryVo database layer.
 *
 * Uses SQLite (via better-sqlite3) so this scaffold runs with zero external
 * services. IMPORTANT: many hosts (e.g. Render's free web service tier)
 * wipe the local filesystem on every redeploy/restart, which would wipe this
 * database too. For real production use, swap this file's connection for a
 * hosted Postgres/MySQL database (e.g. Supabase, Neon, Railway Postgres —
 * most have a free tier) and translate the queries below (they're plain SQL,
 * so the change is mechanical).
 */

require('dotenv').config();
const Database = require('better-sqlite3');

const db = new Database(process.env.DATABASE_FILE || './sentryvo.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    mobile TEXT,
    password_hash TEXT,
    plan TEXT NOT NULL,                 -- 'single' ($50/mo, one platform) | 'multi' ($100/mo, 2+ platforms)
    platforms TEXT,                     -- comma-separated, e.g. "OnlyFans" or "OnlyFans,Chaturbate,PornHub"
    status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | active | cancelled
    checkout_ref TEXT,                  -- our own reference id passed as custom_data.user_id
    ls_subscription_id TEXT,            -- Lemon Squeezy subscription id, once known
    report_frequency_days INTEGER NOT NULL DEFAULT 3, -- 1 for multi plan, 3 for single plan
    last_report_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS original_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,          -- link to the CREATOR'S OWN content, used as proof of ownership
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    source TEXT,               -- e.g. 'google_cse_web', 'google_cse_image'
    matched_alias TEXT,
    platform_hint TEXT,        -- which platform-specific query surfaced this
    hosting_provider TEXT,     -- best-effort RDAP lookup, see hostLookup.js
    status TEXT NOT NULL DEFAULT 'found', -- found | reported | removed
    found_at TEXT DEFAULT (datetime('now')),
    reported_at TEXT,
    removed_at TEXT,
    UNIQUE(user_id, url)
  );

  CREATE TABLE IF NOT EXISTS reports_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at TEXT DEFAULT (datetime('now')),
    new_leaks_count INTEGER DEFAULT 0
  );
`);

// ---------- Users ----------
function createUser({ name, email, mobile, passwordHash, plan, platforms, checkoutRef }) {
  const reportFrequencyDays = plan === 'multi' ? 1 : 3;
  const stmt = db.prepare(`
    INSERT INTO users (name, email, mobile, password_hash, plan, platforms, checkout_ref, report_frequency_days, status)
    VALUES (@name, @email, @mobile, @passwordHash, @plan, @platforms, @checkoutRef, @reportFrequencyDays, 'pending_payment')
  `);
  const info = stmt.run({ name, email, mobile, passwordHash, plan, platforms, checkoutRef, reportFrequencyDays });
  return info.lastInsertRowid;
}

function setUserActiveByCheckoutRef(checkoutRef, lsSubscriptionId) {
  db.prepare(`
    UPDATE users SET status = 'active', ls_subscription_id = ? WHERE checkout_ref = ?
  `).run(lsSubscriptionId || null, checkoutRef);
}

function getUserById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

function getActiveUsers() {
  return db.prepare(`SELECT * FROM users WHERE status = 'active'`).all();
}

function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
}

function markReportSentNow(userId) {
  db.prepare(`UPDATE users SET last_report_at = datetime('now') WHERE id = ?`).run(userId);
}

function isReportDue(user) {
  if (!user.last_report_at) return true;
  const last = new Date(user.last_report_at + 'Z').getTime();
  const dueAt = last + user.report_frequency_days * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// ---------- Aliases ----------
function addAliases(userId, aliasList) {
  const stmt = db.prepare(`INSERT INTO aliases (user_id, alias) VALUES (?, ?)`);
  const insertMany = db.transaction((aliases) => {
    aliases.forEach((a) => stmt.run(userId, a.trim())); 
  });
  insertMany(aliasList.filter(Boolean));
}

function getAliasesForUser(userId) {
  return db.prepare(`SELECT alias FROM aliases WHERE user_id = ?`).all(userId).map((r) => r.alias);
}

// ---------- Original content links (proof of ownership, NOT infringing links) ----------
function addOriginalLinks(userId, urlList) {
  const stmt = db.prepare(`INSERT INTO original_links (user_id, url) VALUES (?, ?)`);
  const insertMany = db.transaction((urls) => {
    urls.forEach((u) => u && stmt.run(userId, u.trim()));
  });
  insertMany(urlList.filter(Boolean));
}

function getOriginalLinksForUser(userId) {
  return db.prepare(`SELECT url FROM original_links WHERE user_id = ?`).all(userId).map((r) => r.url);
}

// ---------- Leaks ----------
function leakExists(userId, url) {
  return !!db.prepare(`SELECT 1 FROM leaks WHERE user_id = ? AND url = ?`).get(userId, url);
}

function insertLeak({ userId, url, title, source, matchedAlias }) {
  db.prepare(`
    INSERT OR IGNORE INTO leaks (user_id, url, title, source, matched_alias, status)
    VALUES (?, ?, ?, ?, ?, 'found')
  `).run(userId, url, title, source, matchedAlias);
}

function getLeaksFoundSince(userId, isoTimestamp) {
  return db.prepare(`
    SELECT * FROM leaks WHERE user_id = ? AND found_at >= ? ORDER BY found_at DESC
  `).all(userId, isoTimestamp);
}

function getLeaksByStatus(userId, status) {
  return db.prepare(`SELECT * FROM leaks WHERE user_id = ? AND status = ?`).all(userId, status);
}

function markLeakStatus(id, status) {
  const column = status === 'reported' ? 'reported_at' : status === 'removed' ? 'removed_at' : null;
  if (column) {
    db.prepare(`UPDATE leaks SET status = ?, ${column} = datetime('now') WHERE id = ?`).run(status, id);
  } else {
    db.prepare(`UPDATE leaks SET status = ? WHERE id = ?`).run(status, id);
  }
}

function setLeakHostingProvider(id, hostingProvider) {
  if (!hostingProvider) return;
  db.prepare(`UPDATE leaks SET hosting_provider = ? WHERE id = ?`).run(hostingProvider, id);
}

function getLeakSummary(userId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'found' THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN status = 'reported' THEN 1 ELSE 0 END) AS reported,
      SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed
    FROM leaks WHERE user_id = ?
  `).get(userId);
  return row;
}

function logReportSent(userId, newLeaksCount) {
  db.prepare(`INSERT INTO reports_sent (user_id, new_leaks_count) VALUES (?, ?)`).run(userId, newLeaksCount);
}

module.exports = {
  db,
  createUser,
  setUserActiveByCheckoutRef,
  getUserById,
  getActiveUsers,
  getUserByEmail,
  markReportSentNow,
  isReportDue,
  addAliases,
  getAliasesForUser,
  addOriginalLinks,
  getOriginalLinksForUser,
  leakExists,
  insertLeak,
  getLeaksFoundSince,
  getLeaksByStatus,
  markLeakStatus,
  setLeakHostingProvider,
  getLeakSummary,
  logReportSent,
};
