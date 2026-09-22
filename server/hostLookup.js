/**
 * Hosting-provider / abuse-contact lookup.
 *
 * Uses RDAP (Registration Data Access Protocol) — the modern, free,
 * no-API-key replacement for classic WHOIS. Two lookups:
 *   1. Domain RDAP — finds the registrar's abuse contact
 *   2. IP RDAP — resolves the hosting provider/network operator and its
 *      abuse contact, which is often more accurate than the registrar for
 *      actually getting content taken down (the host, not the registrar,
 *      controls the server).
 *
 * This is the "find hosting provider and report to them" feature — marked
 * optional in the request because RDAP data completeness varies a lot by
 * registry/registrar, so treat results as best-effort, not guaranteed.
 */
const dns = require('dns').promises;
const fetch = require('node-fetch');

function extractAbuseEmails(rdapJson) {
  const emails = new Set();
  const entities = rdapJson?.entities || [];

  function walk(entityList) {
    for (const entity of entityList) {
      const roles = entity.roles || [];
      const vcard = entity.vcardArray?.[1] || [];
      if (roles.includes('abuse')) {
        for (const field of vcard) {
          if (field[0] === 'email' && field[3]) emails.add(field[3]);
        }
      }
      // RDAP nests entities recursively (e.g. registrar > abuse contact)
      if (entity.entities?.length) walk(entity.entities);
    }
  }
  walk(entities);
  return Array.from(emails);
}

function extractOrgName(rdapJson) {
  const entities = rdapJson?.entities || [];
  for (const entity of entities) {
    const vcard = entity.vcardArray?.[1] || [];
    const fnField = vcard.find((f) => f[0] === 'fn');
    if (fnField && fnField[3]) return fnField[3];
  }
  return rdapJson?.name || null;
}

async function rdapDomainLookup(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { timeout: 8000 });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function rdapIpLookup(ip) {
  try {
    const res = await fetch(`https://rdap.org/ip/${ip}`, { timeout: 8000 });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Returns { abuseEmails: string[], hostingOrg: string|null, registrarOrg: string|null }
 * Any/all fields may be empty if RDAP has no data for this domain/IP — that's
 * common enough that callers should always have a fallback (see
 * guessAbuseEmail in scanner.js).
 */
async function lookupHostingAndAbuseContacts(url) {
  const result = { abuseEmails: [], hostingOrg: null, registrarOrg: null };

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return result;
  }

  // Domain RDAP (registrar-level abuse contact)
  const domainData = await rdapDomainLookup(hostname);
  if (domainData) {
    result.registrarOrg = extractOrgName(domainData);
    extractAbuseEmails(domainData).forEach((e) => result.abuseEmails.push(e));
  }

  // IP RDAP (actual hosting provider — often more useful for takedowns)
  try {
    const { address } = await dns.lookup(hostname);
    const ipData = await rdapIpLookup(address);
    if (ipData) {
      result.hostingOrg = extractOrgName(ipData);
      extractAbuseEmails(ipData).forEach((e) => result.abuseEmails.push(e));
    }
  } catch {
    // DNS resolution failed — skip IP lookup, domain data (if any) still stands
  }

  result.abuseEmails = Array.from(new Set(result.abuseEmails));
  return result;
}

/**
 * Looks for an email address published directly on the leak page itself —
 * many leak/tube/aggregator sites list a contact or DMCA email somewhere on
 * the page (footer, header, contact block) even without a dedicated /contact
 * page. This is often a better target than a generic hosting-provider abuse
 * mailbox, since it's more likely to actually be monitored by whoever runs
 * the site.
 *
 * Deliberately scoped to just the leak URL itself, not a deeper site crawl
 * (no following links to a separate /contact or /dmca page) — keeps this
 * fast and avoids scanning pages that could be behind different rules
 * (paywalls, logins, robots.txt). If nothing is found here, the caller
 * falls back to RDAP / a guessed abuse@ address.
 */
async function findSiteContactEmail(url) {
  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const html = await res.text();

    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = Array.from(new Set(html.match(emailPattern) || []));
    if (!matches.length) return null;

    // Prefer anything that looks purpose-built for takedowns over a random
    // address that might just be a support/sales contact.
    const priority = matches.find((email) => /dmca|abuse|legal|copyright/i.test(email));
    return priority || matches[0];
  } catch {
    return null;
  }
}

/**
 * Extracts other image/video URLs sitting on the SAME page as a leak found
 * on a known site (one already in site_contact_emails) — e.g. finding one
 * indexed photo on a profile page, then also pulling every other photo
 * visible on that same page, so a single takedown notice can cover the
 * whole gallery instead of one email per individually-indexed link.
 *
 * IMPORTANT LIMITATION: this only sees what's present in the page's raw
 * HTML at fetch time. Many sites load their gallery via JavaScript AFTER
 * the initial page load — content added that way is invisible here, since
 * this does a plain HTTP fetch, not a real browser render. Sites that embed
 * their media directly in the server-rendered HTML will work well; sites
 * that lazy-load everything via JS will often yield nothing beyond the one
 * URL already known. That's a real gap, not a bug — fixing it would mean
 * running a full headless browser per page, which is a meaningfully
 * heavier (slower, more resource-intensive) feature worth adding later
 * only if this simpler version turns out to miss too much in practice.
 *
 * Deliberately scoped to just this one page — no following pagination or
 * other links — to keep this fast and predictable.
 */
async function extractMediaLinksFromPage(pageUrl) {
  try {
    const res = await fetch(pageUrl, { timeout: 10000 });
    if (!res.ok) return [];
    const html = await res.text();
    const base = new URL(pageUrl);

    // Covers the common real-world patterns: <img src="...">,
    // <video src="...">/<source src="...">, and direct links to media
    // files in href="..." attributes (many galleries link thumbnails to
    // a full-resolution file).
    const attrPattern = /(?:src|href)=["']([^"']+\.(?:jpe?g|png|gif|webp|mp4|webm|m3u8))(?:[^"']*)["']/gi;
    const found = new Set();
    let match;
    while ((match = attrPattern.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], base).toString();
        found.add(resolved);
      } catch {
        // Malformed URL fragment — skip it rather than fail the whole page
      }
    }

    // Never include the page's own URL as a "new" media link, and cap the
    // count so one unusually large gallery page can't balloon a single
    // scan into hundreds of new leak rows.
    found.delete(pageUrl);
    return Array.from(found).slice(0, 50);
  } catch {
    return [];
  }
}

module.exports = { lookupHostingAndAbuseContacts, findSiteContactEmail, extractMediaLinksFromPage };
