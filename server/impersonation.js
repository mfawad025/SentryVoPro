/**
 * Fake account (impersonation) monitor.
 *
 * Finds profiles on the big platforms that pretend to be a client: a
 * username that looks like one of their names, their name as the display
 * name, or their own photo. Each one starts as 'pending' and is shown only
 * to the admin (daily digest) until the admin confirms it.
 *
 * Statuses:
 *   pending   -> found, waiting for the admin (client doesn't see it)
 *   confirmed -> admin says it's fake; needs reporting on the platform
 *   reported  -> admin submitted the platform's impersonation form
 *   removed   -> the profile is gone (recheck or admin)
 *   dismissed -> not fake (fan page, someone else with the same name, ...)
 *   official  -> it's the client's own account; never flagged again
 *
 * Reporting is NOT automated. Instagram, TikTok, X, Facebook and YouTube
 * only take impersonation reports through their own web forms, often with
 * the person's ID or proof that the reporter represents them; scripting
 * those forms is against their terms and blocked by CAPTCHAs. The digest
 * gives the admin a "report kit" per account (form link + ready-to-paste
 * text) instead. Removal is never guaranteed: the platform decides.
 */
require('dotenv').config();
const fetch = require('node-fetch');
const db = require('./db');
const fingerprint = require('./fingerprint');
const { searchGoogle } = require('./googleSearch');
const { profileHandle, normalizeForMatch, impersonationPlatform, IMPERSONATION_PLATFORMS } = require('./constants');

// Searched once per IMPERSONATION_INTERVAL_HOURS per client, one query per
// alias and platform ("kitsykat" site:instagram.com). Every query costs a
// Serper credit, so the number of aliases searched is capped.
const IMPERSONATION_INTERVAL_HOURS = Math.max(1, Number(process.env.IMPERSONATION_INTERVAL_HOURS) || 24);
const IMPERSONATION_SEARCH_PLATFORMS = String(process.env.IMPERSONATION_PLATFORMS ?? 'instagram,tiktok,x,facebook,youtube')
  .split(',').map((p) => p.trim().toLowerCase()).filter((p) => IMPERSONATION_PLATFORMS[p]);
const IMPERSONATION_MAX_ALIASES = Math.max(1, Number(process.env.IMPERSONATION_MAX_ALIASES) || 3);
// Profile pages opened per run to compare their pictures with the client's
// photos (only for profiles that don't already match by name).
const MAX_PHOTO_CHECKS = 10;
// Reported/confirmed accounts rechecked per run to see if they're gone.
const MAX_RECHECKS = 20;
// A reported account still up after this many days shows up in the digest
// again so it can be reported a second time.
const REREPORT_DAYS = Math.max(1, Number(process.env.IMPERSONATION_REREPORT_DAYS) || 7);

// Which plans get the monitor: 'all' (default) or a comma list of plan
// names (single, multi, agency_starter, ...).
function impersonationEnabledFor(user) {
  const plans = String(process.env.IMPERSONATION_PLANS || 'all').toLowerCase();
  if (plans === 'all') return true;
  return plans.split(',').map((p) => p.trim()).includes(String(user.plan || '').toLowerCase());
}

// ---- Does a username look like the client's name? ----
// Common look-alike swaps (k1tsykat, kitsyk4t) are undone first.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };
function squash(str) {
  return normalizeForMatch(String(str || '').toLowerCase().replace(/[0134578@$]/g, (c) => LEET[c]));
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// True when the handle contains the alias (kitsykat_vip, real.kitsykat), or
// is one or two typos away from it (kitsykatt, kitsycat). Short aliases must
// match exactly: "kat" is inside thousands of unrelated usernames.
function handleLooksLike(alias, handle) {
  const a = squash(alias);
  const h = squash(handle);
  if (!a || !h) return false;
  if (a.length < 4) return h === a;
  if (h.includes(a)) return true;
  const tolerance = a.length >= 9 ? 2 : a.length >= 5 ? 1 : 0;
  if (!tolerance) return false;
  return editDistance(h, a) <= tolerance || editDistance(h.replace(/\d+$/, ''), a) <= tolerance;
}

// Google titles profile pages "Display Name (@handle) • Instagram ...",
// "Display Name (@handle) / X", "Display Name (@handle) | TikTok".
function displayNameFromTitle(title) {
  const m = String(title || '').match(/^(.+?)\s*\(@?[^)]+\)/);
  return m ? m[1].trim() : null;
}

function nameMatches(alias, text) {
  const a = squash(alias);
  const t = squash(text);
  if (!a || !t) return false;
  return a.length < 4 ? t === a : t.includes(a);
}

// The client's own accounts: every profile among their original links plus
// the official_accounts list. Returns a Set of "platform:handle".
async function getOfficialKeys(userId, originalLinks) {
  const keys = new Set();
  for (const url of originalLinks || []) {
    const platform = impersonationPlatform(url);
    const handle = profileHandle(url);
    if (platform && handle) keys.add(`${platform}:${squash(handle)}`);
  }
  for (const row of await db.getOfficialAccounts(userId)) keys.add(`${row.platform}:${squash(row.handle)}`);
  return keys;
}

// Why a profile looks like an impersonation of the client, or null.
function impersonationReason(handle, title, aliases, fingerprintDistance) {
  const alias = aliases.find((a) => handleLooksLike(a, handle));
  if (alias) {
    return squash(handle) === squash(alias)
      ? `Username is exactly "${alias}". If the client has no account here, it could be theirs: check before confirming.`
      : `Username @${handle} looks like "${alias}"`;
  }
  const display = displayNameFromTitle(title);
  const byName = display && aliases.find((a) => nameMatches(a, display));
  if (byName) return `Uses "${display}" as the display name`;
  if (fingerprintDistance !== null && fingerprintDistance !== undefined) return 'Profile picture matches one of the client\'s photos';
  return null;
}

/**
 * Saves a profile page as a fake-account candidate if it looks like one.
 * Called by the search below and by the leak scan (scanner.js), which used
 * to save such profiles as copyright leaks. Returns true when the URL is a
 * profile page at all (so the caller doesn't also save it as a leak).
 */
async function recordProfileCandidate(user, { url, title, fingerprintDistance = null }, aliases, officialKeys) {
  const platform = impersonationPlatform(url);
  const handle = profileHandle(url);
  if (!platform || !handle) return false;
  if (officialKeys.has(`${platform}:${squash(handle)}`)) return true;
  const reason = impersonationReason(handle, title, aliases, fingerprintDistance);
  if (!reason) return true;
  await db.insertImpersonation({
    userId: user.id,
    platform,
    handle: handle.toLowerCase(),
    url,
    title,
    reason,
    fingerprintDistance,
  });
  return true;
}

function isRunDue(user) {
  if (!user.last_impersonation_at) return true;
  return Date.now() - new Date(user.last_impersonation_at).getTime() >= IMPERSONATION_INTERVAL_HOURS * 60 * 60 * 1000 - 20 * 60 * 1000;
}

// ---- Is a reported account gone? ----
// Platforms often serve bots a login page, so only clear signs count:
// 404/410, or the platform's own "account doesn't exist" message. Anything
// else (including network errors) leaves the status as it is.
const GONE_MARKERS = [
  "Sorry, this page isn't available", // Instagram, Threads
  "Couldn't find this account", // TikTok
  "This content isn't available right now", // Facebook
  "This page isn't available", // Facebook
  'This channel does not exist', // YouTube
  "This account doesn't exist", // X
  'Account suspended', // X
];

async function isProfileGone(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      timeout: 10000,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SentryVoBot/1.0; +https://www.sentryvo.com)', accept: 'text/html' },
    });
    if ([404, 410].includes(res.status)) return true;
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 500000);
    return GONE_MARKERS.some((m) => html.includes(m));
  } catch {
    return false;
  }
}

async function recheckReported(user) {
  const open = await db.getImpersonationsByStatus(user.id, ['confirmed', 'reported']);
  let removed = 0;
  for (const imp of open.slice(0, MAX_RECHECKS)) {
    if (await isProfileGone(imp.url)) {
      await db.setImpersonationStatus(imp.id, 'removed');
      removed++;
    }
  }
  return removed;
}

/**
 * The daily fake-account search for one client. Returns query counts so the
 * scan summary includes them. force skips the once-a-day limit.
 */
async function runImpersonationSearch(user, aliases, originalLinks, fingerprints, { force = false } = {}) {
  const out = { queries: 0, failed: 0, found: 0, removed: 0, reasons: [] };
  if (!impersonationEnabledFor(user) || !IMPERSONATION_SEARCH_PLATFORMS.length) return out;
  if (!force && !isRunDue(user)) return out;

  const officialKeys = await getOfficialKeys(user.id, originalLinks);
  const before = await db.countImpersonations(user.id);
  let photoChecks = MAX_PHOTO_CHECKS;
  const seen = new Set();

  for (const alias of aliases.slice(0, IMPERSONATION_MAX_ALIASES)) {
    for (const key of IMPERSONATION_SEARCH_PLATFORMS) {
      out.queries++;
      try {
        const results = await searchGoogle(`"${alias}" site:${IMPERSONATION_PLATFORMS[key].searchDomain}`);
        for (const r of results) {
          if (seen.has(r.url) || !profileHandle(r.url)) continue;
          seen.add(r.url);
          let distance = null;
          // A profile that doesn't match by name may still use the client's
          // photo as its picture.
          if (!impersonationReason(profileHandle(r.url), r.title, aliases, null) && fingerprints.length && photoChecks > 0) {
            photoChecks--;
            for (const h of await fingerprint.hashPageImages(r.url)) {
              const d = fingerprint.bestMatch(h, fingerprints);
              if (d !== null && (distance === null || d < distance)) distance = d;
            }
          }
          await recordProfileCandidate(user, { url: r.url, title: r.title, fingerprintDistance: distance }, aliases, officialKeys);
        }
      } catch (err) {
        out.failed++;
        out.reasons.push(err.message);
        console.warn(`Fake account search failed for "${alias}" on ${key} (${user.email}):`, err.message);
      }
    }
  }

  out.removed = await recheckReported(user);
  out.found = (await db.countImpersonations(user.id)) - before;
  await db.markImpersonationRun(user.id);
  if (out.found || out.removed) console.log(`Fake accounts for ${user.email}: ${out.found} new candidate(s), ${out.removed} gone.`);
  return out;
}

// ---- Report kit ----
// The ready-to-paste text for the platform's impersonation form.
function buildReportText(user, imp, aliases, officialUrls) {
  const agentName = process.env.DMCA_AGENT_NAME || '[DMCA_AGENT_NAME not set]';
  const agentEmail = process.env.DMCA_AGENT_EMAIL || process.env.REPORT_FROM_EMAIL || '';
  const platform = IMPERSONATION_PLATFORMS[imp.platform]?.name || imp.platform;
  const names = aliases.length ? ` (known online as ${aliases.join(', ')})` : '';
  return [
    `I am ${agentName}, the authorized representative of ${user.name}${names}.`,
    ``,
    `The ${platform} account @${imp.handle} (${imp.url}) is pretending to be ${user.name}. It is not run by ${user.name} and was not created with their permission.`,
    ``,
    officialUrls.length
      ? `${user.name}'s real account(s):\n${officialUrls.map((u) => `- ${u}`).join('\n')}`
      : `${user.name} does not have an official account at this address.`,
    ``,
    `Why we believe this account is fake: ${String(imp.reason || '').replace(/\.$/, '')}.`,
    ``,
    `Fake accounts like this one mislead and scam ${user.name}'s fans. Please remove it for impersonation.`,
    ``,
    `Contact: ${agentName}${agentEmail ? `, ${agentEmail}` : ''}`,
  ].join('\n');
}

// Every official link we know of for the client, for the report text.
async function officialUrlsFor(user) {
  const urls = [...await db.getOriginalLinksForUser(user.id)];
  for (const row of await db.getOfficialAccounts(user.id)) if (!urls.includes(row.url)) urls.push(row.url);
  return urls;
}

module.exports = {
  impersonationEnabledFor,
  handleLooksLike,
  displayNameFromTitle,
  impersonationReason,
  getOfficialKeys,
  recordProfileCandidate,
  runImpersonationSearch,
  isProfileGone,
  buildReportText,
  officialUrlsFor,
  REREPORT_DAYS,
};
