require('dotenv').config();
const cron = require('node-cron');
const { runDailyScanForAllUsers, scanRunInfo } = require('./scanner');
const db = require('./db');
const { sendAdminDigestEmail } = require('./emailReport');

// Health of each active client for the admin's daily email: when they were
// last scanned and emailed, how many links were found in the last 24 hours,
// and warnings when something is late or searches failed.
async function buildClientStatus() {
  const { scanIntervalHours, lastScanStats } = require('./scanner');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = [];
  for (const u of await db.getActiveUsers()) {
    const warnings = [];
    const lastScan = u.last_scan_at ? new Date(u.last_scan_at).getTime() : null;
    if (!lastScan || Date.now() - lastScan > (scanIntervalHours(u) + 3) * 60 * 60 * 1000) warnings.push('Scan is overdue');
    if (db.isReportDue(u)) warnings.push('Report is due but was not sent (check the logs for "Report failed")');
    const stats = lastScanStats.get(u.id);
    if (stats && stats.queriesFailed) warnings.push(`${stats.queriesFailed} of ${stats.queriesRun} searches failed in the last scan (Serper credits?)`);
    rows.push({
      name: u.name,
      email: u.email,
      plan: u.plan,
      lastScanAt: u.last_scan_at,
      lastReportAt: u.last_report_at,
      newLast24h: await db.countLeaksSince(u.id, since),
      warnings,
    });
  }
  return rows;
}

// The admin's daily email: every link that needs reporting by hand, plus the
// status of every client. Sent every day, also when there is nothing new, so
// a missing email always means something is wrong.
async function sendAdminDigestIfNeeded({ includeSent = false } = {}) {
  try {
    const pendingLeaks = await db.getPendingAdminDigestLeaks({ includeSent });
    const status = await buildClientStatus();
    await sendAdminDigestEmail(pendingLeaks, status);
    await db.markLeaksDigestSent(pendingLeaks.map((l) => l.id));
    console.log(`Admin daily email sent: ${pendingLeaks.length} link(s), ${status.length} client(s).`);
    return { sent: pendingLeaks.length, clients: status.length };
  } catch (err) {
    console.error('Admin daily email failed:', err.message);
    return { sent: 0, error: err.message };
    // Deliberately don't mark anything as sent if the email itself failed —
    // these items stay pending and get included in tomorrow's digest
    // instead of silently disappearing.
  }
}

// Once a day, at the first check at or after ADMIN_DIGEST_HOUR local time
// (REPORT_TIMEZONE, default the same hour as the client reports). The day
// it was sent is stored in the database so a restart can't send it twice
// or skip it.
const { localTime, REPORT_HOUR } = require('./constants');
const ADMIN_DIGEST_HOUR = Number(process.env.ADMIN_DIGEST_HOUR ?? REPORT_HOUR);
let lastDigestDay = null;

async function sendDailyDigestIfDue() {
  const now = localTime();
  if (now.hour < ADMIN_DIGEST_HOUR) return;
  if (lastDigestDay === null) lastDigestDay = Number(await db.getAppState('admin_digest_day')) || 0;
  if (lastDigestDay >= now.day) return;
  const result = await sendAdminDigestIfNeeded();
  if (!result.error) {
    lastDigestDay = now.day;
    await db.setAppState('admin_digest_day', now.day);
  }
}

// One scheduled check: scan the clients that are due, then send the daily
// admin digest if it is due. Used by the in-process hourly cron and by
// /api/cron/tick, which an outside scheduler can call to wake a server that
// sleeps when idle (e.g. Render's free plan, where node-cron never fires).
let checkInProgress = false;
let lastCheck = null;
async function runScheduledCheck(source = 'cron') {
  if (checkInProgress) return { skipped: true };
  checkInProgress = true;
  lastCheck = { source, at: new Date().toISOString() };
  try {
    const results = await runDailyScanForAllUsers();
    if (results.length) {
      console.log(`[${new Date().toISOString()}] (${source}) Scanned ${results.length} client(s) that were due.`);
    }
    // After the scans, so the digest includes anything they just found.
    await sendDailyDigestIfDue();
    return { scanned: results.length };
  } finally {
    checkInProgress = false;
  }
}

function startDailyScanCron() {
  // Checks every hour; each client is scanned when their plan's interval
  // has passed (scanner.js isScanDue). DAILY_SCAN_CRON is no longer used.
  const schedule = process.env.SCAN_CHECK_CRON || '7 * * * *';
  if (process.env.DAILY_SCAN_CRON) {
    console.warn('DAILY_SCAN_CRON is no longer used. Scans are now hourly checks; set SCAN_CHECK_CRON to change that.');
  }
  if (!cron.validate(schedule)) {
    console.error(`Invalid SCAN_CHECK_CRON value: "${schedule}" — falling back to hourly`);
  }

  cron.schedule(cron.validate(schedule) ? schedule : '7 * * * *', () => runScheduledCheck('cron'));

  console.log(`Scan check scheduled: "${schedule}"`);
}

function scheduleStatus() {
  return { lastCheck, checkInProgress, scanRun: scanRunInfo(), lastDigestDay, adminDigestHour: ADMIN_DIGEST_HOUR, serverTime: new Date().toString() };
}

module.exports = { startDailyScanCron, sendAdminDigestIfNeeded, runScheduledCheck, scheduleStatus };
