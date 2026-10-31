/**
 * Prospect outreach (admin only).
 *
 * Finds creators who have public leaks of their name, shows them that in a
 * short, explicit-free email, and contacts them ONLY through a business
 * address they published themselves, and ONLY after the admin approves each
 * email. Never sends takedowns, Google requests or site reports for people
 * who are not clients.
 *
 * Flow per prospect (statuses):
 *   new -> scanned -> contact_found | dm_manually -> approved -> sent
 *       -> replied | opted_out | signed_up      (or skipped by the admin)
 *
 * Safety rules enforced here:
 *   - an email can be approved only with a published business address, a
 *     region where cold email is allowed (US / other, not EU-UK-Canada),
 *     at least OUTREACH_MIN_MATCHES matches, and all sender settings filled
 *     in (name, address, postal address);
 *   - at most OUTREACH_DAILY_LIMIT emails per 24 hours, one follow-up after
 *     OUTREACH_FOLLOWUP_DAYS, nothing after a reply or opt-out;
 *   - every email carries why we write, where the address was found, an
 *     opt-out link (+ one-click List-Unsubscribe) and the postal address;
 *   - opted-out addresses are never contacted again;
 *   - prospects who never sign up are deleted after PROSPECT_RETENTION_DAYS.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('./db');
const { localTime } = require('./constants');
const { findContact } = require('./prospectContact');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);
const CFG = {
  fromName: () => process.env.OUTREACH_FROM_NAME || '',
  fromEmail: () => process.env.OUTREACH_FROM_EMAIL || '',
  replyTo: () => process.env.OUTREACH_REPLY_TO || process.env.OUTREACH_FROM_EMAIL || '',
  postal: () => process.env.OUTREACH_POSTAL_ADDRESS || '',
  dailyLimit: () => num(process.env.OUTREACH_DAILY_LIMIT, 10),
  followupDays: () => num(process.env.OUTREACH_FOLLOWUP_DAYS, 4),
  minMatches: () => num(process.env.OUTREACH_MIN_MATCHES, 3),
  scansPerDay: () => num(process.env.PROSPECT_SCANS_PER_DAY, 20),
  retentionDays: () => num(process.env.PROSPECT_RETENTION_DAYS, 90),
  site: () => (process.env.SENTRYVO_SITE_URL || 'https://www.sentryvo.com').replace(/\/$/, ''),
  api: () => (process.env.API_PUBLIC_URL || 'https://api.sentryvo.com').replace(/\/$/, ''),
};

// Regions: cold marketing email to individuals needs prior consent in the
// EU, UK and Canada, so those prospects are contacted by DM instead.
const REGIONS = { us: 'United States', other: 'Other (not EU/UK/Canada)', eu_uk_ca: 'EU, UK or Canada', unknown: 'Unknown' };
const EMAIL_REGIONS = ['us', 'other'];
const STATUSES = ['new', 'scanned', 'contact_found', 'dm_manually', 'approved', 'sent', 'replied', 'opted_out', 'signed_up', 'skipped'];
const CLOSED = ['sent', 'replied', 'opted_out', 'signed_up', 'skipped'];

function missingSettings() {
  const missing = [];
  if (!CFG.fromName()) missing.push('OUTREACH_FROM_NAME');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(CFG.fromEmail())) missing.push('OUTREACH_FROM_EMAIL');
  if (!CFG.postal()) missing.push('OUTREACH_POSTAL_ADDRESS');
  if (!process.env.ADMIN_SECRET_KEY) missing.push('ADMIN_SECRET_KEY');
  if (!(process.env.OUTREACH_SMTP_HOST || process.env.SMTP_HOST)) missing.push('SMTP_HOST (or OUTREACH_SMTP_HOST)');
  return missing;
}

function parseAliases(handle, aliasesText) {
  const list = [handle, ...String(aliasesText || '').split(/[,\n]/)].map((a) => String(a || '').trim().replace(/^@/, '')).filter(Boolean);
  return [...new Set(list.map((a) => a.toLowerCase()))].map((low) => list.find((a) => a.toLowerCase() === low)).slice(0, 6);
}

// A handle from a link-in-bio address: linktr.ee/lunademo -> lunademo.
function handleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg) return decodeURIComponent(seg).replace(/^@/, '');
    const sub = u.hostname.split('.');
    return sub.length > 2 ? sub[0] : null;
  } catch {
    return null;
  }
}

function sourceLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/linktr\.ee$/.test(host)) return 'your Linktree page';
    if (/beacons\.ai$/.test(host)) return 'your Beacons page';
    if (/carrd\.co$/.test(host)) return 'your Carrd page';
    if (/allmylinks\.com$/.test(host)) return 'your AllMyLinks page';
    return `your website (${host})`;
  } catch {
    return 'your public page';
  }
}

// ---------- opt-out links ----------
function optOutToken(email) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET_KEY || '').update(`opt-out:${String(email).toLowerCase()}`).digest('hex').slice(0, 32);
}
function optOutUrl(email) {
  return `${CFG.api()}/api/outreach/opt-out?e=${encodeURIComponent(String(email).toLowerCase())}&t=${optOutToken(email)}`;
}
function checkOptOutToken(email, token) {
  const a = Buffer.from(String(token || '')), b = Buffer.from(optOutToken(email));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- daily scan cap ----------
async function takeScanSlot() {
  const today = localTime().day;
  let state = {};
  try { state = JSON.parse((await db.getAppState('prospect_scans')) || '{}'); } catch { state = {}; }
  const used = state.day === today ? state.n : 0;
  if (used >= CFG.scansPerDay()) return false;
  await db.setAppState('prospect_scans', JSON.stringify({ day: today, n: used + 1 }));
  return true;
}
async function scansUsedToday() {
  try {
    const state = JSON.parse((await db.getAppState('prospect_scans')) || '{}');
    return state.day === localTime().day ? state.n : 0;
  } catch {
    return 0;
  }
}

function ownLinksOf(p) {
  let links = [];
  try { links = JSON.parse(p.own_links || '[]'); } catch { links = []; }
  return [p.source_url, ...links].filter(Boolean);
}

// ---------- steps ----------
async function scanProspectById(id) {
  const p = await db.getProspect(id);
  if (!p) throw new Error('Prospect not found');
  if (!(await takeScanSlot())) throw new Error(`Daily prospect scan limit reached (${CFG.scansPerDay()}). Try again tomorrow or raise PROSPECT_SCANS_PER_DAY.`);
  const { scanProspect } = require('./scanner');
  const aliases = parseAliases(p.handle, p.aliases);
  const { results, queries, failed } = await scanProspect(aliases, ownLinksOf(p));
  await db.replaceProspectResults(id, results);
  const next = CLOSED.includes(p.status) || p.status === 'approved' ? p.status
    : p.contact_email ? 'contact_found' : p.contact_source === 'none' ? 'dm_manually' : 'scanned';
  const updated = await db.updateProspect(id, { match_count: results.length, scanned_at: new Date().toISOString(), status: next });
  return { prospect: updated, queries, failed };
}

async function findContactById(id) {
  const p = await db.getProspect(id);
  if (!p) throw new Error('Prospect not found');
  if (!p.source_url) throw new Error('Add the creator\'s link-in-bio or website address first');
  const found = await findContact(p.source_url);
  const fields = { own_links: JSON.stringify(found.ownLinks) };
  if (found.email && await db.isEmailBlocked(found.email)) {
    Object.assign(fields, { contact_email: found.email, contact_source: found.source, status: 'opted_out' });
  } else if (found.email) {
    Object.assign(fields, { contact_email: found.email, contact_source: found.source });
    if (!CLOSED.includes(p.status) && p.status !== 'approved') fields.status = 'contact_found';
  } else {
    fields.contact_source = 'none';
    if (!CLOSED.includes(p.status) && p.status !== 'approved') fields.status = 'dm_manually';
  }
  return db.updateProspect(id, fields);
}

function scanLink(p) {
  const alias = parseAliases(p.handle, p.aliases)[0] || p.handle;
  return `${CFG.site()}/?scan=${encodeURIComponent(alias)}&ref=prospect-${p.id}#free-scan-input`;
}

function topSites(results, n = 3) {
  const count = {};
  for (const r of results) count[r.site] = (count[r.site] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, n).map(([site]) => site);
}

function buildDraft(p, results) {
  const name = p.handle;
  const sites = topSites(results);
  const siteText = sites.length > 1 ? `${sites.slice(0, -1).join(', ')} and ${sites[sites.length - 1]}` : sites[0] || 'several sites';
  const sender = CFG.fromName() || '{your name}';
  const subject = `Quick heads-up about your content, ${name}`;
  const body = `Hi ${name},

I'm ${sender} from SentryVo. We help creators find and remove copies of their content that are posted without permission.

While checking public search results, we noticed ${p.match_count} pages that appear to use your name, on sites such as ${siteText}. I haven't included the links here, for your privacy.

If you'd like to see them yourself, you can run a free scan in a few seconds, no account needed:
${scanLink(p)}

If they turn out to be yours, we can send the takedown notices for you and keep watching for new copies.

No pressure at all, and feel free to ignore this if it's not useful.

Best regards,
${sender}
SentryVo · www.sentryvo.com`;
  return { subject, body };
}

function followupDraft(p) {
  const sender = CFG.fromName() || '{your name}';
  return {
    subject: `Re: ${p.draft_subject || `Quick heads-up about your content, ${p.handle}`}`,
    body: `Hi ${p.handle},

Just a short follow-up on my last email. The free scan is still here if you'd like to check what's out there under your name:
${scanLink(p)}

If you'd like help removing anything, just reply and I'll take care of it.

Best,
${sender}, SentryVo`,
  };
}

// Added to every email at send time; the admin can't edit it away.
function footer(p) {
  return `

---
I'm writing because this address is listed as your business contact on ${sourceLabel(p.contact_source)}. If you'd rather not hear from us, unsubscribe here and we won't contact you again: ${optOutUrl(p.contact_email)}
Privacy policy: ${CFG.site()}/privacy.html
SentryVo, ${CFG.postal()}`;
}

function dmTemplate(p) {
  return `Hi ${p.handle}! I'm ${CFG.fromName() || '{your name}'} from SentryVo. We help creators remove leaked content. We noticed a few pages using your name. You can check for free here: ${scanLink(p)} Happy to help if you need it 🙂`;
}

async function makeDraft(id) {
  const p = await db.getProspect(id);
  if (!p) throw new Error('Prospect not found');
  const { subject, body } = buildDraft(p, await db.getProspectResults(id));
  return db.updateProspect(id, { draft_subject: subject, draft_body: body });
}

// Why this prospect can't be approved yet ([] = ready).
async function approvalProblems(p) {
  const problems = [];
  const missing = missingSettings();
  if (missing.length) problems.push(`Fill in these settings on Render first: ${missing.join(', ')}`);
  if (!p.contact_email) problems.push('No published business email (contact this creator by DM instead)');
  else if (await db.isEmailBlocked(p.contact_email)) problems.push('This address opted out');
  if (!EMAIL_REGIONS.includes(p.region)) problems.push('Set the region to United States or Other. EU, UK and Canada prospects are contacted by DM only');
  if (p.match_count < CFG.minMatches()) problems.push(`Needs at least ${CFG.minMatches()} matches (has ${p.match_count})`);
  if (!p.draft_subject || !p.draft_body) problems.push('Build the email draft first');
  if (CLOSED.includes(p.status)) problems.push(`Already ${p.status.replace('_', ' ')}`);
  return problems;
}

async function approve(id, { subject, body } = {}) {
  let p = await db.getProspect(id);
  if (!p) throw new Error('Prospect not found');
  if (subject || body) p = await db.updateProspect(id, { draft_subject: subject || p.draft_subject, draft_body: body || p.draft_body });
  const problems = await approvalProblems(p);
  if (problems.length) {
    const err = new Error(problems.join('. '));
    err.status = 400;
    throw err;
  }
  await db.updateProspect(id, { status: 'approved', approved_at: new Date().toISOString() });
  const sent = await sendQueued();
  return { prospect: await db.getProspect(id), sentNow: sent.includes(id) };
}

function mailer() {
  const host = process.env.OUTREACH_SMTP_HOST || process.env.SMTP_HOST;
  const port = Number(process.env.OUTREACH_SMTP_PORT || process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: process.env.OUTREACH_SMTP_USER || process.env.SMTP_USER, pass: process.env.OUTREACH_SMTP_PASS || process.env.SMTP_PASS },
  });
}

async function sendEmail(p, kind) {
  const { subject, body } = kind === 'followup' ? followupDraft(p) : { subject: p.draft_subject, body: p.draft_body };
  const text = body + footer(p);
  await mailer().sendMail({
    from: { name: `${CFG.fromName()} at SentryVo`, address: CFG.fromEmail() },
    replyTo: CFG.replyTo(),
    to: p.contact_email,
    subject,
    text,
    headers: {
      'List-Unsubscribe': `<${optOutUrl(p.contact_email)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  await db.logProspectEmail({ prospectId: p.id, kind, to: p.contact_email, subject, body: text });
  console.log(`Outreach ${kind} email sent to prospect ${p.id}.`);
}

async function sentLast24h() {
  return db.countProspectEmailsSince(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

// Sends approved first emails, oldest approval first, within the daily cap.
async function sendQueued() {
  const sentIds = [];
  if (missingSettings().length) return sentIds;
  let room = CFG.dailyLimit() - await sentLast24h();
  const queue = (await db.listProspects()).filter((p) => p.status === 'approved').sort((a, b) => new Date(a.approved_at) - new Date(b.approved_at));
  for (const p of queue) {
    if (room <= 0) break;
    if ((await approvalProblems({ ...p, status: 'new' })).length) continue;   // e.g. opted out since approval
    try {
      await sendEmail(p, 'first');
      await db.updateProspect(p.id, { status: 'sent', sent_at: new Date().toISOString() });
      sentIds.push(p.id);
      room--;
    } catch (err) {
      console.error(`Outreach email to prospect ${p.id} failed:`, err.message);
    }
  }
  return sentIds;
}

// One follow-up, OUTREACH_FOLLOWUP_DAYS after the first email, only if there
// was no reply, opt-out or sign-up.
async function sendFollowups() {
  if (missingSettings().length) return 0;
  let room = CFG.dailyLimit() - await sentLast24h();
  const due = Date.now() - CFG.followupDays() * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const p of await db.listProspects()) {
    if (room <= 0) break;
    if (p.status !== 'sent' || p.followup_sent_at || p.replied_at || !p.sent_at || new Date(p.sent_at).getTime() > due) continue;
    if (!p.contact_email || await db.isEmailBlocked(p.contact_email)) continue;
    try {
      await sendEmail(p, 'followup');
      await db.updateProspect(p.id, { followup_sent_at: new Date().toISOString() });
      room--;
      n++;
    } catch (err) {
      console.error(`Outreach follow-up to prospect ${p.id} failed:`, err.message);
    }
  }
  return n;
}

// Run from the hourly scheduled check.
async function runOutreachJobs() {
  try {
    const today = localTime().day;
    if (Number(await db.getAppState('prospect_cleanup_day')) !== today) {
      const removed = await db.deleteOldProspects(CFG.retentionDays());
      await db.setAppState('prospect_cleanup_day', today);
      if (removed) console.log(`Outreach: deleted ${removed} prospect(s) older than ${CFG.retentionDays()} days.`);
    }
    const sent = await sendQueued();
    const followups = await sendFollowups();
    if (sent.length || followups) console.log(`Outreach: ${sent.length} first email(s), ${followups} follow-up(s) sent.`);
  } catch (err) {
    console.error('Outreach jobs failed:', err.message);
  }
}

// A visitor who arrived from an outreach email (?ref=prospect-ID) signed up.
async function markSignedUp(ref, userId) {
  const m = /^prospect-(\d+)$/.exec(String(ref || ''));
  if (!m) return;
  const p = await db.getProspect(Number(m[1]));
  if (p && p.status !== 'signed_up') await db.updateProspect(p.id, { status: 'signed_up', signed_up_user_id: userId });
}

async function stats() {
  const all = await db.listProspects();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const p of all) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  return {
    total: all.length,
    byStatus,
    sentLast24h: await sentLast24h(),
    dailyLimit: CFG.dailyLimit(),
    scansToday: await scansUsedToday(),
    scansPerDay: CFG.scansPerDay(),
    minMatches: CFG.minMatches(),
    followupDays: CFG.followupDays(),
    retentionDays: CFG.retentionDays(),
    missingSettings: missingSettings(),
  };
}

module.exports = {
  REGIONS, STATUSES, EMAIL_REGIONS,
  parseAliases, handleFromUrl, sourceLabel, missingSettings,
  scanProspectById, findContactById, makeDraft, buildDraft, followupDraft, footer, dmTemplate,
  approvalProblems, approve, sendQueued, sendFollowups, runOutreachJobs,
  optOutUrl, checkOptOutToken, markSignedUp, stats,
};
