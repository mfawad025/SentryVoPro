require('dotenv').config();
const cron = require('node-cron');
const { runDailyScanForAllUsers } = require('./scanner');

function startDailyScanCron() {
  const schedule = process.env.DAILY_SCAN_CRON || '0 8 * * *';

  if (!cron.validate(schedule)) {
    console.error(`Invalid DAILY_SCAN_CRON value: "${schedule}" — falling back to 08:00 daily`);
  }

  cron.schedule(cron.validate(schedule) ? schedule : '0 8 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Running daily scan for all active users…`);
    const results = await runDailyScanForAllUsers();
    console.log(`Daily scan finished for ${results.length} user(s).`);
  });

  console.log(`Daily scan cron scheduled: "${schedule}"`);
}

module.exports = { startDailyScanCron };
