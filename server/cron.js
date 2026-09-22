require('dotenv').config();
const cron = require('node-cron');
const { runDailyScanForAllUsers } = require('./scanner');
const db = require('./db');
const { sendAdminDigestEmail } = require('./emailReport');

async function sendAdminDigestIfNeeded() {
  try {
    const pendingLeaks = await db.getPendingAdminDigestLeaks();
    if (!pendingLeaks.length) {
      console.log('Admin digest: nothing new to report today.');
      return;
    }
    await sendAdminDigestEmail(pendingLeaks);
    await db.markLeaksDigestSent(pendingLeaks.map((l) => l.id));
    console.log(`Admin digest sent: ${pendingLeaks.length} item(s).`);
  } catch (err) {
    console.error('Admin digest failed:', err.message);
    // Deliberately don't mark anything as sent if the email itself failed —
    // these items stay pending and get included in tomorrow's digest
    // instead of silently disappearing.
  }
}

function startDailyScanCron() {
  const schedule = process.env.DAILY_SCAN_CRON || '0 8 * * *';

  if (!cron.validate(schedule)) {
    console.error(`Invalid DAILY_SCAN_CRON value: "${schedule}" — falling back to 08:00 daily`);
  }

  cron.schedule(cron.validate(schedule) ? schedule : '0 8 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Running daily scan for all active users…`);
    const results = await runDailyScanForAllUsers();
    console.log(`Daily scan finished for ${results.length} user(s).`);

    // Runs once per day, AFTER every user's scan is done — aggregates
    // across everyone rather than sending a separate digest per client.
    await sendAdminDigestIfNeeded();
  });

  console.log(`Daily scan cron scheduled: "${schedule}"`);
}

module.exports = { startDailyScanCron, sendAdminDigestIfNeeded };
