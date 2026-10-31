/**
 * Public contact finder for prospect outreach (see outreach.js).
 *
 * Reads the creator's own link-in-bio page (Linktree, Beacons, Carrd, ...)
 * and, if needed, up to two of their own websites linked from it. An email
 * is kept only when the page presents it as a business / booking / contact
 * address. Nothing is guessed, no login-only platform is read, and no list
 * is bought. Also returns the creator's own links, so the prospect scan never
 * counts their own pages.
 */
const { safeFetch } = require('./fingerprint');
const { isMajorPlatform } = require('./constants');

const MAX_HTML = 1.5 * 1024 * 1024;
const BUSINESS_WORDS = /(business|booking|bookings|contact|collab|collaborat|enquir|inquir|management|manager|press|partnership|sponsor|work with me|email me|e-mail me|promo)/i;
const BUSINESS_LOCAL = /^(business|booking|bookings|contact|collab|collabs|hello|hi|info|inquiries|enquiries|management|mgmt|press|partnerships|team|work)\b/i;
const BAD_DOMAINS = /(^|\.)(example\.(com|org)|domain\.com|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|linktr\.ee|beacons\.ai|carrd\.co|onlyfans\.com|fansly\.com|godaddy\.com|cloudflare\.com)$/i;
const CREATOR_HOSTS = /(^|\.)(onlyfans\.com|fansly\.com|linktr\.ee|beacons\.ai|allmylinks\.com|carrd\.co|manyvids\.com|fancentro\.com|chaturbate\.com|patreon\.com|throne\.com|amazon\.[a-z.]+|cash\.app|paypal\.me|ko-fi\.com|buymeacoffee\.com)$/i;

function decode(html) {
  return html
    .replace(/\\u0040/gi, '@').replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/\\u002e/gi, '.').replace(/&#0*46;/g, '.')
    .replace(/\\\//g, '/');
}

const strip = (x) => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// The label that belongs to the email at `index`: the text of its mailto
// link, the "title" of its Linktree-style JSON entry, or for an email in
// plain text the few words right before it ("Bookings: x@y.com").
function labelFor(html, index, matchText) {
  const before = html.slice(Math.max(0, index - 160), index);
  const after = html.slice(index + matchText.length, index + matchText.length + 200);
  if (/href=["']mailto:$/i.test(before.slice(-14))) {
    const m = after.match(/^[^"']*["'][^>]*>([\s\S]{0,120}?)<\/a>/i);
    return { mailto: true, label: m ? strip(m[1]) : '' };
  }
  if (/"url"\s*:\s*"mailto:$/i.test(before.slice(-20))) {
    const m = before.match(/"title"\s*:\s*"([^"]{0,100})"[^{}]*$/i);
    return { mailto: true, label: m ? m[1] : '' };
  }
  // plain text: only the words in the same element/line, right before it
  return { mailto: false, label: before.split(/<[^>]*>|\n/).pop().slice(-45) };
}

// Emails on the page that are presented as business/contact addresses.
function businessEmails(rawHtml) {
  const html = decode(rawHtml);
  const out = new Set();
  const re = /([a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,24})/gi;
  let m;
  while ((m = re.exec(html))) {
    const email = m[1].toLowerCase().replace(/\.+$/, '');
    const [local, domain] = email.split('@');
    if (BAD_DOMAINS.test(domain) || /\.(png|jpe?g|gif|webp|svg)$/i.test(email) || /noreply|no-reply|donotreply/.test(local)) continue;
    const { mailto, label } = labelFor(html, m.index, m[0]);
    if (BUSINESS_WORDS.test(label) || (mailto && BUSINESS_LOCAL.test(local))) out.add(email);
  }
  return [...out];
}

// Outgoing links on the page (also those inside JSON, as Linktree uses).
function pageLinks(rawHtml, baseUrl) {
  const html = decode(rawHtml);
  const links = new Set();
  const re = /(?:href=["']|"url"\s*:\s*")(https?:\/\/[^"'\s<>]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.hostname === new URL(baseUrl).hostname) continue;
      links.add(u.href.replace(/[),.]+$/, ''));
    } catch { /* bad URL */ }
  }
  return [...links].slice(0, 60);
}

async function fetchHtml(url) {
  const page = await safeFetch(url, { typePrefix: 'text/html', maxBytes: MAX_HTML, accept: 'text/html' });
  return page ? { html: page.buffer.toString('utf8'), url: page.finalUrl } : null;
}

/**
 * Returns { email, source, ownLinks }. email/source are null when no
 * published business address was found (the admin then contacts by DM).
 */
async function findContact(sourceUrl) {
  const result = { email: null, source: null, ownLinks: [] };
  if (!sourceUrl) return result;
  const first = await fetchHtml(sourceUrl);
  if (!first) return result;
  result.ownLinks = pageLinks(first.html, first.url);
  const emails = businessEmails(first.html);
  if (emails.length) return { ...result, email: emails[0], source: first.url };

  // Their own website(s), linked from the bio page: home page and /contact.
  const sites = [...new Set(result.ownLinks
    .map((l) => { try { return new URL(l); } catch { return null; } })
    .filter((u) => u && !CREATOR_HOSTS.test(u.hostname) && !isMajorPlatform(u.href))
    .map((u) => u.origin))].slice(0, 2);
  for (const origin of sites) {
    for (const path of ['/', '/contact']) {
      const page = await fetchHtml(origin + path);
      if (!page) continue;
      const found = businessEmails(page.html);
      if (found.length) return { ...result, email: found[0], source: page.url };
    }
  }
  return result;
}

module.exports = { findContact, businessEmails, pageLinks };
