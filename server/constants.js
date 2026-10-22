// Google has no public API for third-party copyright removal requests —
// their tool is a web form. See the note in scanner.js for the full
// explanation. This lives in its own file so both scanner.js and
// excelReport.js can reference it without a circular require.
const GOOGLE_REMOVAL_TOOL_URL = 'https://reportcontent.google.com/forms/dmca_search';

// Major platforms have their own dedicated copyright/report forms — these
// are NOT automated (see the long comment in scanner.js for why), but each
// entry's URL gives the admin a direct link to the right form instead of
// having to go find it themselves.
const MAJOR_PLATFORM_REPORT_LINKS = {
  'youtube.com': 'https://www.youtube.com/copyright_complaint_form',
  'youtu.be': 'https://www.youtube.com/copyright_complaint_form',
  'ytimg.com': 'https://www.youtube.com/copyright_complaint_form',
  'googlevideo.com': 'https://www.youtube.com/copyright_complaint_form',
  'tiktok.com': 'https://www.tiktok.com/legal/report/copyright',
  'tiktokcdn.com': 'https://www.tiktok.com/legal/report/copyright',
  'tiktokv.com': 'https://www.tiktok.com/legal/report/copyright',
  'facebook.com': 'https://www.facebook.com/help/contact/634636770043106',
  'fb.com': 'https://www.facebook.com/help/contact/634636770043106',
  'fb.watch': 'https://www.facebook.com/help/contact/634636770043106',
  'fbcdn.net': 'https://www.facebook.com/help/contact/634636770043106',
  'instagram.com': 'https://help.instagram.com/contact/372592039493408',
  'instagr.am': 'https://help.instagram.com/contact/372592039493408',
  'cdninstagram.com': 'https://help.instagram.com/contact/372592039493408',
  'x.com': 'https://help.x.com/forms/dmca',
  'twitter.com': 'https://help.x.com/forms/dmca',
  // X/Twitter media + short-link domains (pbs.twimg.com for images,
  // video.twimg.com for videos, t.co for shortened links).
  'twimg.com': 'https://help.x.com/forms/dmca',
  't.co': 'https://help.x.com/forms/dmca',
  'reddit.com': 'https://www.reddit.com/report/copyright',
  // Reddit's media/short-link domains (i.redd.it, preview.redd.it, ...) —
  // images posted to Reddit live here, not on reddit.com, so without these
  // they were treated as ordinary sites and a notice went to Reddit's
  // hosting abuse address instead of using Reddit's own copyright form.
  'redd.it': 'https://www.reddit.com/report/copyright',
  'redditmedia.com': 'https://www.reddit.com/report/copyright',
  'redditstatic.com': 'https://www.reddit.com/report/copyright',
  'reddituploads.com': 'https://www.reddit.com/report/copyright',
  'pinterest.com': 'https://policy.pinterest.com/en/copyright-infringement-form',
  'pinimg.com': 'https://policy.pinterest.com/en/copyright-infringement-form',
  'tumblr.com': 'https://www.tumblr.com/dmca',
  'linkedin.com': 'https://www.linkedin.com/help/linkedin/ask/TSO-DMCA',
  'licdn.com': 'https://www.linkedin.com/help/linkedin/ask/TSO-DMCA',
  'snapchat.com': 'https://values.snap.com/en-US/report/copyright',
  'sc-cdn.net': 'https://values.snap.com/en-US/report/copyright',
  'threads.net': 'https://help.instagram.com/contact/372592039493408',
};

const MAJOR_PLATFORM_DOMAINS = Object.keys(MAJOR_PLATFORM_REPORT_LINKS);

// Checks whether a URL belongs to one of the major platforms above —
// matches the exact domain or any subdomain of it (e.g. m.youtube.com).
function isMajorPlatform(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return MAJOR_PLATFORM_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// Returns the specific reporting form URL for a major-platform leak, or
// null if the URL isn't one of the platforms above.
function getMajorPlatformReportLink(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const match = MAJOR_PLATFORM_DOMAINS.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    return match ? MAJOR_PLATFORM_REPORT_LINKS[match] : null;
  } catch {
    return null;
  }
}

// The page URL to give Google's removal form for a leak. Google delists
// PAGES from its search results. Image-search leaks are stored by image
// file URL, but their snippet begins with the page that hosts the image, so
// use that when present.
function googleDelistUrl(leak) {
  const isHttp = (u) => /^https?:\/\//i.test(u || '');
  if (leak.source === 'serper_image') {
    const first = String(leak.snippet || '').trim().split(/\s+/)[0];
    if (isHttp(first)) return first;
  }
  return isHttp(leak.url) ? leak.url : null;
}

// Sites that belong to the same company. If a client's original link is on
// ANY domain in a family, every domain in that family (and its subdomains)
// counts as the client's own content and is never reported — e.g. a client
// with a pornhub.com model page is also covered on phncdn.com (media) and
// the pornhub.org / pornhub.net mirrors. Only domains confidently known to
// be the company's own go here; add more through OWN_DOMAIN_FAMILIES_EXTRA
// in Render (JSON, e.g. [["example.com","examplecdn.com"]]).
const OWN_DOMAIN_FAMILIES = [
  ['pornhub.com', 'pornhub.org', 'pornhub.net', 'phncdn.com', 'modelhub.com'],
  ['chaturbate.com', 'highwebmedia.com'],
];

function getOwnDomainFamilies() {
  let extra = [];
  try {
    const parsed = JSON.parse(process.env.OWN_DOMAIN_FAMILIES_EXTRA || '[]');
    if (Array.isArray(parsed)) extra = parsed.filter(Array.isArray);
  } catch {
    // Bad JSON in the env var — ignore it rather than break scanning.
  }
  return [...OWN_DOMAIN_FAMILIES, ...extra];
}

const GOOGLE_DMCA_FORM_URL = 'https://reportcontent.google.com/forms/dmca_search';

/**
 * Relevance check: does this search result actually mention the client's
 * alias? Google returns pages that match only PART of a query (e.g. just
 * "asmr" or just "leaked"), so without this every unrelated creator's page
 * became a "leak" — and then received a DMCA notice. Comparison ignores
 * case, spaces, punctuation and accents, so alias "jaxi asmr" matches a
 * title "Jaxi ASMR", a URL ".../jaxi-asmr/..." or a snippet "jaxiasmr".
 * The full alias must appear — a match on only one word is not enough.
 */
function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function matchesAlias(alias, ...fields) {
  const needle = normalizeForMatch(alias);
  if (!needle) return false;
  // Each field on its own: joining them first would let the end of one field
  // and the start of the next combine into a false match ("...jaxi" + "asmr...").
  return fields.some((f) => normalizeForMatch(f).includes(needle));
}

// ---- Profile pages on big platforms ----
// A profile page (x.com/name, instagram.com/name, reddit.com/user/name, ...)
// shows whatever that account posted lately, so Google often titles it with
// a post that merely mentions the client ("... @kitsykat ..."). That is not
// a leak. Such a page is kept only when the account's own username contains
// one of the client's names (a fake or impersonation account) or one of the
// client's photos matched. Individual posts are not affected.
const PROFILE_RULES = [
  // [domain, function(pathSegments, url) -> handle or null]
  [['x.com', 'twitter.com'], (p) => (p.length >= 1 && p.length <= 2 && !['i', 'search', 'hashtag', 'home', 'explore', 'intent', 'share', 'settings', 'messages', 'notifications'].includes(p[0].toLowerCase()) && (p.length === 1 || ['media', 'with_replies', 'likes', 'highlights', 'photo', 'header_photo'].includes(p[1].toLowerCase())) ? p[0] : null)],
  [['instagram.com', 'threads.net'], (p) => (p.length >= 1 && p.length <= 2 && !['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'post', 't'].includes(p[0].toLowerCase()) && (p.length === 1 || ['reels', 'tagged', 'replies', 'media'].includes(p[1].toLowerCase())) ? p[0].replace(/^@/, '') : null)],
  [['tiktok.com'], (p) => (p.length === 1 && p[0].startsWith('@') ? p[0].slice(1) : null)],
  [['reddit.com'], (p) => (p.length >= 2 && ['user', 'u'].includes(p[0].toLowerCase()) && !p.includes('comments') ? p[1] : null)],
  [['youtube.com'], (p) => (p.length >= 1 && p[0].startsWith('@') ? p[0].slice(1) : p.length >= 2 && ['c', 'channel', 'user'].includes(p[0].toLowerCase()) && (p.length === 2 || ['videos', 'shorts', 'featured', 'streams'].includes(p[2].toLowerCase())) ? p[1] : null)],
  [['facebook.com'], (p, u) => (p.length === 1 && p[0].toLowerCase() === 'profile.php' ? (u.searchParams.get('id') || '') : p.length === 1 && !/\.php$/i.test(p[0]) && !['watch', 'groups', 'events', 'marketplace', 'share', 'reel', 'photo', 'stories', 'gaming'].includes(p[0].toLowerCase()) ? p[0] : null)],
  [['pinterest.com'], (p) => (p.length === 1 && !['pin', 'search', 'ideas'].includes(p[0].toLowerCase()) ? p[0] : null)],
  [['tumblr.com'], (p, u) => (u.hostname.replace(/^www\./, '') !== 'tumblr.com' ? (p.length === 0 ? u.hostname.split('.')[0] : null) : p.length === 1 && !['tagged', 'search', 'explore', 'dashboard'].includes(p[0].toLowerCase()) ? p[0] : null)],
  [['snapchat.com'], (p) => (p.length === 2 && p[0].toLowerCase() === 'add' ? p[1] : null)],
  [['linkedin.com'], (p) => (p.length === 2 && p[0].toLowerCase() === 'in' ? p[1] : null)],
];

// The account name if the URL is a big platform's profile page, else null.
function profileHandle(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|mobile|old)\./, '').toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  for (const [domains, rule] of PROFILE_RULES) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      const handle = rule(segments, u);
      return handle === null || handle === undefined ? null : String(handle);
    }
  }
  return null;
}

// True for a big-platform profile page that should NOT be reported: the
// username doesn't contain any of the client's names and no photo matched.
function isUnverifiedProfilePage(url, aliases, fingerprintDistance = null) {
  const handle = profileHandle(url);
  if (handle === null) return false;
  if (fingerprintDistance !== null && fingerprintDistance !== undefined) return false;
  return !(aliases || []).filter(Boolean).some((a) => matchesAlias(a, handle));
}

// ---- Local time for the daily emails ----
// Client reports and the admin's daily email go out at a fixed local time
// (REPORT_HOUR in REPORT_TIMEZONE, default 9:00 Pakistan time), not at
// whatever time a scan happened to finish.
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Karachi';
const REPORT_HOUR = Number(process.env.REPORT_HOUR ?? 9);

// { day: whole days since 1970 in that zone, hour: 0-23 }
function localTime(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(date)).map((p) => [p.type, p.value]));
  return {
    day: Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000),
    hour: Number(parts.hour),
  };
}

function formatLocalTime(date) {
  if (!date) return 'never';
  return new Date(date).toLocaleString('en-GB', {
    timeZone: REPORT_TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ---- One-click actions in the admin digest email ----
// Each "Not a leak" / "Approve" link carries a signature made with
// ADMIN_SECRET_KEY, so the link works for that one leak and action only and
// the admin key itself never appears in an email.
const LEAK_ACTIONS = ['dismiss', 'approve'];

function leakActionToken(id, action) {
  const secret = process.env.ADMIN_SECRET_KEY || '';
  return require('crypto').createHmac('sha256', secret).update(`leak-action:${action}:${id}`).digest('hex').slice(0, 32);
}

function leakActionUrl(id, action) {
  const base = (process.env.API_PUBLIC_URL || 'https://api.sentryvo.com').replace(/\/$/, '');
  return `${base}/api/leak-action?id=${id}&a=${action}&t=${leakActionToken(id, action)}`;
}

module.exports = {
  REPORT_TIMEZONE,
  REPORT_HOUR,
  localTime,
  formatLocalTime,
  LEAK_ACTIONS,
  leakActionToken,
  leakActionUrl,
  matchesAlias,
  normalizeForMatch,
  profileHandle,
  isUnverifiedProfilePage,
  getOwnDomainFamilies,
  googleDelistUrl,
  GOOGLE_DMCA_FORM_URL,
  GOOGLE_REMOVAL_TOOL_URL,
  MAJOR_PLATFORM_DOMAINS,
  MAJOR_PLATFORM_REPORT_LINKS,
  isMajorPlatform,
  getMajorPlatformReportLink,
};
