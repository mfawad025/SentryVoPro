/**
 * Lemon Squeezy integration.
 *
 * Uses the simplest supported flow: a "checkout link" per plan (copied from
 * your Lemon Squeezy dashboard — Store > Products > [product] > Share), with
 * query params appended to prefill the buyer's details and attach custom
 * data linking the purchase back to your local user record.
 *
 * PRICING MODEL: two plans, each with a first-time-customer discount:
 *   - Single Keyword/Account: $50/mo, $30 for a customer's first payment
 *   - Multiple Keywords/Accounts: $100/mo, $80 for a customer's first payment
 *
 * The discount is applied via a Lemon Squeezy DISCOUNT CODE, not a separate
 * checkout link — set this up once in your dashboard:
 *   Store > Discounts > New Discount
 *     - Amount: $20 off (works for both plans since it's a flat discount)
 *     - Restrict to: "First order only" / "New customers only" (Lemon
 *       Squeezy enforces this server-side, so it can't be reused or abused
 *       by editing the URL)
 *   Then put that discount's CODE in LEMONSQUEEZY_FIRST_ORDER_DISCOUNT_CODE
 *   in .env — every checkout link will include it, and Lemon Squeezy
 *   silently ignores it for anyone who isn't eligible.
 *
 * No API key is needed for this flow (that's only required if you want to
 * generate checkouts dynamically via the API instead of query params — see
 * https://docs.lemonsqueezy.com/api/checkouts if you outgrow this later).
 *
 * You DO need the webhook signing secret, to verify that webhook requests
 * really came from Lemon Squeezy.
 */
require('dotenv').config();
const crypto = require('crypto');

const CHECKOUT_URLS = {
  single: process.env.LEMONSQUEEZY_CHECKOUT_URL_SINGLE,
  multi: process.env.LEMONSQUEEZY_CHECKOUT_URL_MULTI,
};

function buildCheckoutUrl(planKey, { userId, name, email }) {
  const base = CHECKOUT_URLS[planKey];
  if (!base) {
    throw new Error(`No Lemon Squeezy checkout URL configured for plan "${planKey}"`);
  }

  const url = new URL(base);
  url.searchParams.set('checkout[email]', email);
  url.searchParams.set('checkout[name]', name);
  url.searchParams.set('checkout[custom][user_id]', String(userId));
  // Keeps the buyer on a consistent, embeddable experience; safe to remove.
  url.searchParams.set('embed', '1');

  const discountCode = process.env.LEMONSQUEEZY_FIRST_ORDER_DISCOUNT_CODE;
  if (discountCode) {
    url.searchParams.set('checkout[discount_code]', discountCode);
  }

  return url.toString();
}

/**
 * Verifies the X-Signature header Lemon Squeezy sends with every webhook.
 * IMPORTANT: this must run against the *raw* request body bytes, before any
 * JSON parsing — see index.js, which uses express.raw() for this route.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

module.exports = { buildCheckoutUrl, verifyWebhookSignature };
