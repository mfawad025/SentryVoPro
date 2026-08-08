/**
 * Daily scan + takedown pipeline for one user.
 *
 * Flow: search each of the user's aliases -> record new leaks -> attempt an
 * automatic best-effort takedown notice -> recheck previously-reported leaks
 * to see if they've come down -> return a summary for the email report.
 *
 * IMPORTANT CAVEATS (read before relying on this in production):
 * - "Automatic takedown" here means emailing a best-effort guessed abuse
 *   contact (abuse@<hostname>) with a templated DMCA notice. Many hosts
 *   don't use that address, require a web form instead, or need a human to
 *   review evidence first. Treat the "reported" status as "a notice was
 *   attempted," not "guaranteed delivered to the right recipient" — the
 *   WardMark case-file review process (or your own manual review) is still
 *   the reliable path for anything that matters.
 * - "Removed" detection here is a simple HTTP status recheck. A host can
 *   return 200 while still showing the content in some other way (behind a
 *   login wall, cached, etc.), so treat this as a signal, not certainty.
 */
require('dotenv').config();
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { searchGoogle, searchGoogleImages } = require('./googleSearch');
const db = require('./db');
const { sendDailyReportEmail } = require('./emailReport');
const { lookupHostingAndAbuseContacts } = require('./hostLookup');
const { GOOGLE_REMOVAL_TOOL_URL } = require('./constants');

// Google does not offer a public API for third parties to submit copyright
// removal requests — their "Remove content from Google" tool is a web form
// (https://reportcontent.google.com), typically requiring the reporter to
// fill it in directly, sometimes per-URL. Automating actual submission
// would mean scripting a login-gated web form, which is fragile and against
// Google's terms of service — so this is NOT automated. Instead, every
// report includes a ready reference link so submitting manually takes
// seconds instead of research time.

// Known leak-prone destinations worth checking specifically, beyond a plain
// web search. Extend this list as you learn where your subscribers' content
// tends to turn up.
const LEAK_PRONE_SITES = ['reddit.com', 't.me', 'x.com', 'tumblr.com'];

function buildTextQueries(alias, platforms) {
  const queries = [
    `"${alias}" leaked`,
    `"${alias}" leaked photos OR videos`,
  ];
  // One query per platform the subscriber is actually on — sharper signal
  // than a generic query, and keeps quota usage proportional to relevance.
  platforms.forEach((platform) => {
    queries.push(`"${alias}" ${platform} leaked`);
  });
  // Site-restricted checks across common re-posting/leak destinations
  LEAK_PRONE_SITES.forEach((site) => {
    queries.push(`"${alias}" site:${site}`);
  });
  return queries;
}

function buildImageQueries(alias) {
  return [`"${alias}" leaked photos`];
}

function guessAbuseEmail(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return `abuse@${hostname}`;
  } catch {
    return null;
  }
}

function getMailer() {
  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.yourprovider.com') return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function attemptTakedownNotice(leak, user) {
  const mailer = getMailer();
  if (!mailer) return false;

  // Best-effort: look up the real hosting provider / registrar abuse contact
  // via RDAP first (more likely to reach someone who can actually act), and
  // fall back to the guessed abuse@<hostname> address if RDAP has nothing.
  let hostingOrg = null;
  let targetEmails = [];
  try {
    const lookup = await lookupHostingAndAbuseContacts(leak.url);
    hostingOrg = lookup.hostingOrg || lookup.registrarOrg;
    targetEmails = lookup.abuseEmails;
  } catch (err) {
    console.warn(`RDAP lookup failed for ${leak.url}:`, err.message);
  }
  if (hostingOrg) db.setLeakHostingProvider(leak.id, hostingOrg);

  if (!targetEmails.length) {
    const guessed = guessAbuseEmail(leak.url);
    if (guessed) targetEmails = [guessed];
  }
  if (!targetEmails.length) return false;

  const subject = `DMCA Takedown Notice — ${leak.url}`;
  const body = [
    `This is a formal DMCA takedown notice under 17 U.S.C. §512.`,
    ``,
    `I am submitting this notice on behalf of the rights holder, ${user.name}, regarding copyrighted content published without authorization at:`,
    leak.url,
    ``,
    `The content infringes on copyrighted material owned by ${user.name}. I have a good faith belief that use of this material is not authorized by the copyright owner, its agent, or the law.`,
    `I swear, under penalty of perjury, that the information in this notice is accurate and that I am authorized to act on behalf of the copyright owner.`,
    ``,
    `Please remove or disable access to this content as soon as possible.`,
    ``,
    `Reference: SentryVo case for ${user.email}`,
  ].join('\n');

  try {
    await mailer.sendMail({
      from: process.env.REPORT_FROM_EMAIL,
      to: targetEmails.join(', '),
      subject,
      text: body,
    });
    return true;
  } catch (err) {
    console.warn(`Takedown notice failed for ${leak.url}:`, err.message);
    return false;
  }
}

async function recheckLeak(leak) {
  try {
    const res = await fetch(leak.url, { method: 'GET', redirect: 'follow', timeout: 10000 });
    // Very rough heuristic: 404/410/403 or a redirect to a different host
    // suggests the content is no longer there. Confirm manually for
    // anything that matters — this is a signal, not proof.
    const finalHost = new URL(res.url).hostname;
    const originalHost = new URL(leak.url).hostname;
    if ([404, 410, 403].includes(res.status) || finalHost !== originalHost) {
      return true;
    }
    return false;
  } catch {
    // Unreachable often means taken down (DNS gone, connection refused, etc.)
    return true;
  }
}

async function runDailyScanForUser(user) {
  const scanStart = new Date().toISOString();
  const aliases = db.getAliasesForUser(user.id);
  const platforms = (user.platforms || '').split(',').map((p) => p.trim()).filter(Boolean);

  for (const alias of aliases) {
    // Text search: leak-site mentions, forum posts, social platform posts
    for (const query of buildTextQueries(alias, platforms)) {
      try {
        const results = await searchGoogle(query);
        for (const result of results) {
          if (!db.leakExists(user.id, result.url)) {
            db.insertLeak({
              userId: user.id,
              url: result.url,
              title: result.title,
              source: 'google_cse_web',
              matchedAlias: alias,
            });
          }
        }
      } catch (err) {
        console.warn(`Text scan failed for alias "${alias}" (user ${user.email}):`, err.message);
      }
    }

    // Image search: reposted photos on Google Images
    for (const query of buildImageQueries(alias)) {
      try {
        const results = await searchGoogleImages(query);
        for (const result of results) {
          if (!db.leakExists(user.id, result.url)) {
            db.insertLeak({
              userId: user.id,
              url: result.url,
              title: result.title,
              source: 'google_cse_image',
              matchedAlias: alias,
            });
          }
        }
      } catch (err) {
        console.warn(`Image scan failed for alias "${alias}" (user ${user.email}):`, err.message);
      }
    }
  }

  // Attempt takedown notices for anything newly found
  const newlyFound = db.getLeaksByStatus(user.id, 'found');
  for (const leak of newlyFound) {
    const sent = await attemptTakedownNotice(leak, user);
    if (sent) db.markLeakStatus(leak.id, 'reported');
  }

  // Recheck previously-reported leaks for removal
  const reported = db.getLeaksByStatus(user.id, 'reported');
  for (const leak of reported) {
    const removed = await recheckLeak(leak);
    if (removed) db.markLeakStatus(leak.id, 'removed');
  }

  // Scanning runs every day regardless of plan (catch things fast), but the
  // EMAIL only goes out on the subscriber's plan cadence — daily for the
  // multi-platform ($100) plan, every 3 days for the single-platform ($50)
  // plan (see report_frequency_days in db.js).
  if (db.isReportDue(user)) {
    const sinceTimestamp = user.last_report_at || scanStart;
    const leaksSinceLastReport = db.getLeaksFoundSince(user.id, sinceTimestamp);
    const summary = db.getLeakSummary(user.id);

    await sendDailyReportEmail(user, leaksSinceLastReport, summary);
    db.logReportSent(user.id, leaksSinceLastReport.length);
    db.markReportSentNow(user.id);

    return { user: user.email, reportSent: true, newLeaks: leaksSinceLastReport.length, summary };
  }

  return { user: user.email, reportSent: false };
}

async function runDailyScanForAllUsers() {
  const users = db.getActiveUsers();
  const results = [];
  for (const user of users) {
    try {
      results.push(await runDailyScanForUser(user));
    } catch (err) {
      console.error(`Daily scan failed for ${user.email}:`, err.message);
    }
  }
  return results;
}

// Allow running manually: `npm run scan-now`
if (require.main === module && process.argv.includes('--run-once')) {
  runDailyScanForAllUsers()
    .then((r) => {
      console.log('Scan complete:', r);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runDailyScanForUser, runDailyScanForAllUsers, GOOGLE_REMOVAL_TOOL_URL };
