require('dotenv').config();
const cron = require('node-cron');
const { runDailyScanForAllUsers } = require('./scanner');
const db = require('./db');
const { sendAdminDigestEmail } = require('./emailReport');

async function sendAdminDigestIfNeeded({ includeSent = false } = {}) {
  try {
    const pendingLeaks = await db.getPendingAdminDigestLeaks({ includeSent });
    if (!pendingLeaks.length) {
      console.log('Admin digest: nothing new to report today.');
      return { sent: 0 };
    }
    await sendAdminDigestEmail(pendingLeaks);
    await db.markLeaksDigestSent(pendingLeaks.map((l) => l.id));
    console.log(`Admin digest sent: ${pendingLeaks.length} item(s).`);
    return { sent: pendingLeaks.length };
  } catch (err) {
    console.error('Admin digest failed:', err.message);
    return { sent: 0, error: err.message };
    // Deliberately don't mark anything as sent if the email itself failed —
    // these items stay pending and get included in tomorrow's digest
    // instead of silently disappearing.
  }
}

// The admin digest still goes out once a day: on the first run at or after
// ADMIN_DIGEST_HOUR (server time, default 8 = the old daily scan time).
const ADMIN_DIGEST_HOUR = Number(process.env.ADMIN_DIGEST_HOUR ?? 8);
let lastDigestDay = null;

async function sendDailyDigestIfDue() {
  const now = new Date();
  const today = now.toDateString();
  if (lastDigestDay === today || now.getHours() < ADMIN_DIGEST_HOUR) return;
  lastDigestDay = today;
  await sendAdminDigestIfNeeded();
}

// One scheduled check: scan the clients that are due, then send the daily
// admin digest if it is due. Used by the in-process hourly cron and by
// /api/cron/tick, which an outside scheduler can call to wake a server that
// sleeps when idle (e.g. Render's free plan, where node-cron never fires).
let checkInProgress = false;
async function runScheduledCheck(source = 'cron') {
  if (checkInProgress) return { skipped: true };
  checkInProgress = true;
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

module.exports = { startDailyScanCron, sendAdminDigestIfNeeded, runScheduledCheck };
