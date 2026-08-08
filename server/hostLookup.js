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

module.exports = { lookupHostingAndAbuseContacts };
