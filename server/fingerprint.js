/**
 * Content fingerprinting — matches a client's ORIGINAL photos against images
 * found online, without any face recognition or biometric data.
 *
 * How it works: each original image is reduced to a 64-bit "difference hash"
 * (dHash): shrink to 9x8 grayscale, then record for every pixel whether it is
 * brighter than its right-hand neighbour. The hash survives resizing,
 * re-compression, watermarks and mild colour changes, so a re-uploaded copy
 * of the same photo lands within a few bits of the original. Only the 16-hex
 * hash is stored — never the image itself.
 *
 * Matching is deliberately conservative (MAX_DISTANCE) because a wrong match
 * can lead to a wrong takedown notice.
 */
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const fetch = require('node-fetch');
const sharp = require('sharp');

// Max differing bits (out of 64) for two images to count as the same photo.
// Kept strict on purpose: a false match can trigger a wrong takedown notice.
// Override with FINGERPRINT_MAX_DISTANCE if genuine copies are being missed.
const MAX_DISTANCE = Number(process.env.FINGERPRINT_MAX_DISTANCE || 5);
// Skip near-uniform images (blank/solid-colour thumbnails) — their hashes
// carry no information and would match each other.
const MIN_PIXEL_STDDEV = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/**
 * Hashes an image buffer. Returns { hash, flippedHash } as 16-char hex
 * strings, or null if the image is unreadable or too uniform to fingerprint.
 * flippedHash is the hash of the mirror image, so a horizontally flipped
 * re-upload (a common evasion trick) still matches.
 */
async function hashImageBuffer(buffer) {
  let pixels;
  try {
    pixels = await sharp(buffer, { failOn: 'none', limitInputPixels: 100_000_000 })
      .rotate() // respect EXIF orientation
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
  if (pixels.length < 72) return null;

  const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
  const variance = pixels.reduce((a, b) => a + (b - mean) ** 2, 0) / pixels.length;
  if (Math.sqrt(variance) < MIN_PIXEL_STDDEV) return null;

  return { hash: dHash(pixels, false), flippedHash: dHash(pixels, true) };
}

function dHash(pixels, mirror) {
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 9; x++) row.push(pixels[y * 9 + x]);
    if (mirror) row.reverse();
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (row[x] < row[x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function hammingDistance(hexA, hexB) {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * Compares a candidate image's hashes against a client's stored hashes.
 * Returns the smallest distance if it is within MAX_DISTANCE, else null.
 */
function bestMatch(candidate, storedHashes) {
  if (!candidate) return null;
  let best = null;
  for (const stored of storedHashes) {
    const d = Math.min(
      hammingDistance(candidate.hash, stored),
      hammingDistance(candidate.flippedHash, stored)
    );
    if (best === null || d < best) best = d;
  }
  return best !== null && best <= MAX_DISTANCE ? best : null;
}

// ---------- Safe remote image download ----------
// The scanner downloads URLs taken from search results, i.e. attacker-
// influenced input. These guards stop it being used to reach internal
// services (SSRF): only public http(s) hosts, private/loopback/link-local
// addresses rejected at connection time, redirects re-checked, strict size
// and time limits.

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not a valid IP — refuse
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    const publicOnes = list.filter((a) => !isPrivateAddress(a.address));
    if (!publicOnes.length) return callback(new Error('Blocked: host resolves to a private address'));
    if (options && options.all) return callback(null, publicOnes);
    return callback(null, publicOnes[0].address, publicOnes[0].family);
  });
}

const safeHttpAgent = new http.Agent({ lookup: safeLookup });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

function safeAgentFor(url) {
  return String(url).startsWith('https:') ? safeHttpsAgent : safeHttpAgent;
}

/**
 * Downloads a URL with all the SSRF/size/time guards above. Returns
 * { buffer, contentType, finalUrl } or null on any problem (blocked host,
 * wrong content type, too big, timeout, network error) — callers just skip.
 * `typePrefix` restricts the Content-Type (e.g. 'image/' or 'text/html').
 */
async function safeFetch(url, { typePrefix, maxBytes = MAX_IMAGE_BYTES, accept = '*/*', redirectsLeft = MAX_REDIRECTS } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (net.isIP(parsed.hostname) && isPrivateAddress(parsed.hostname)) return null;

  try {
    const res = await fetch(parsed.href, {
      redirect: 'manual',
      timeout: FETCH_TIMEOUT_MS,
      size: maxBytes,
      agent: safeAgentFor(parsed.href),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SentryVoBot/1.0)', Accept: accept },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (redirectsLeft <= 0) return null;
      const next = new URL(res.headers.get('location'), parsed.href).href;
      return safeFetch(next, { typePrefix, maxBytes, accept, redirectsLeft: redirectsLeft - 1 });
    }
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (typePrefix && !contentType.startsWith(typePrefix)) return null;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) return null;
    return { buffer: await res.buffer(), contentType, finalUrl: parsed.href };
  } catch {
    return null; // timeout, oversize, DNS block, network error — just skip
  }
}

async function downloadImage(url) {
  const got = await safeFetch(url, { typePrefix: 'image/', accept: 'image/*' });
  return got ? got.buffer : null;
}

async function hashImageUrl(url) {
  const buffer = await downloadImage(url);
  if (!buffer) return null;
  return hashImageBuffer(buffer);
}

// ---------- Images inside a result page ----------
// Google Images only shows some of what a leak page contains. For a web
// result we also look at the page's own preview image(s): the social-share
// image (og:image / twitter:image) that nearly every gallery or post page
// declares, plus the first couple of large-looking <img> tags.
const MAX_PAGE_HTML_BYTES = 1.5 * 1024 * 1024;
const MAX_PAGE_IMAGES = 3;
const JUNK_IMAGE = /(logo|icon|sprite|avatar|favicon|pixel|spacer|blank|banner|ads?[/_.-]|emoji|badge)/i;

function metaContent(html, attr, name) {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${name}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function extractPageImageUrls(html, pageUrl) {
  const found = [];
  const add = (raw) => {
    if (!raw || found.length >= MAX_PAGE_IMAGES) return;
    try {
      const abs = new URL(raw, pageUrl).href;
      if (/^https?:/i.test(abs) && !found.includes(abs)) found.push(abs);
    } catch {
      /* malformed URL — skip */
    }
  };

  add(metaContent(html, 'property', 'og:image'));
  add(metaContent(html, 'property', 'og:image:url'));
  add(metaContent(html, 'name', 'twitter:image'));
  add(metaContent(html, 'name', 'twitter:image:src'));
  const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
  if (linkImg) add(linkImg[1]);

  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while (found.length < MAX_PAGE_IMAGES && (m = imgRe.exec(html)) !== null) {
    if (JUNK_IMAGE.test(m[1]) || m[1].startsWith('data:')) continue;
    add(m[1]);
  }
  return found;
}

/**
 * Fetches a result page and fingerprints its preview images. Returns an
 * array of { hash, flippedHash } (possibly empty). Safe to call on any URL.
 */
async function hashPageImages(pageUrl) {
  const page = await safeFetch(pageUrl, {
    typePrefix: 'text/html',
    maxBytes: MAX_PAGE_HTML_BYTES,
    accept: 'text/html',
  });
  if (!page) return [];
  const urls = extractPageImageUrls(page.buffer.toString('utf8'), page.finalUrl);
  const hashes = [];
  for (const u of urls) {
    const h = await hashImageUrl(u);
    if (h) hashes.push(h);
  }
  return hashes;
}

module.exports = {
  MAX_DISTANCE,
  hashImageBuffer,
  hashImageUrl,
  hashPageImages,
  extractPageImageUrls,
  safeAgentFor,
  hammingDistance,
  bestMatch,
  isPrivateAddress,
};
