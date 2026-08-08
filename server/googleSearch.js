/**
 * Thin wrapper around Google's Custom Search JSON API.
 * Docs: https://developers.google.com/custom-search/v1/overview
 *
 * Free tier: 100 queries/day. Paid: ~$5 per 1,000 queries beyond that.
 * Each call here is ONE query — if you search multiple aliases per user,
 * multiply accordingly when estimating your daily quota.
 */
require('dotenv').config();
const fetch = require('node-fetch');

async function searchGoogle(query) {
  return runQuery(query, {});
}

async function searchGoogleImages(query) {
  return runQuery(query, { searchType: 'image' });
}

async function runQuery(query, extraParams) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;

  if (!apiKey || !cx || apiKey === 'your_google_api_key') {
    throw new Error('Google Custom Search is not configured (GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX missing)');
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  Object.entries(extraParams).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google CSE request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.items || []).map((item) => ({
    url: item.link,
    title: item.title,
  }));
}

module.exports = { searchGoogle, searchGoogleImages };
