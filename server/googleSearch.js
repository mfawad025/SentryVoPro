/**
 * Search wrapper — now backed by Serper.dev instead of Google Custom Search.
 *
 * Why the switch: as of January 2026, Google discontinued "search the
 * entire web" for new Programmable Search Engines — new engines are capped
 * to a manually curated list of up to 50 sites, which made the scanner far
 * narrower than intended. Serper.dev proxies real, unrestricted Google
 * search results with no such cap.
 *
 * Docs: https://serper.dev/docs
 * Pricing: ~2,500 free queries on signup, then roughly $1 per 1,000 queries
 * beyond that — cheap enough at this project's current scale that it's
 * barely worth metering closely, but keep an eye on it as subscriber count
 * (and therefore daily query volume) grows.
 *
 * The function names and return shape (`[{ url, title }]`) are unchanged
 * from the old Google CSE version on purpose — scanner.js and index.js
 * (the free scan endpoint) call these exactly as before, no changes needed
 * anywhere else.
 */
require('dotenv').config();
const fetch = require('node-fetch');

const SERPER_BASE = 'https://google.serper.dev';

async function searchGoogle(query) {
  const data = await runQuery('/search', query);
  const organic = data.organic || [];
  return organic.map((item) => ({
    url: item.link,
    title: item.title,
    // Google's result snippet — used by scanner.js to verify the result
    // actually mentions the client's alias (see matchesAlias).
    snippet: item.snippet || '',
  }));
}

async function searchGoogleImages(query) {
  const data = await runQuery('/images', query);
  const images = data.images || [];
  return images.map((item) => ({
    // Serper's images response has used slightly different field names
    // across versions of their API — check both to stay resilient.
    url: item.imageUrl || item.link,
    title: item.title,
    // For images there's no snippet, so expose the host page link and
    // source name instead — the alias often appears in the page URL.
    snippet: [item.link, item.source].filter(Boolean).join(' '),
    // Small preview image — much cheaper to download for fingerprinting
    // than the full-size original.
    thumbnail: item.thumbnailUrl || null,
  }));
}

async function runQuery(path, query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey || apiKey === 'your_serper_api_key') {
    throw new Error('Serper.dev is not configured (SERPER_API_KEY missing)');
  }

  const res = await fetch(`${SERPER_BASE}${path}`, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    // num above 10 is rejected on Serper's free trial ("Query pattern not
    // allowed for free accounts") and needs a paid credit pack — now
    // purchased. Requests for 11-100 results cost 2 credits instead of 1
    // (100 costs the same as 60). If the 400 error ever returns, the
    // paid credits have likely run out or expired (6-month validity) —
    // check the Serper dashboard and drop this to 10 as a stopgap.
    body: JSON.stringify({ q: query, num: 100 }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Serper.dev request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  return res.json();
}

module.exports = { searchGoogle, searchGoogleImages };
