/**
 * Lemon Squeezy integration.
 *
 * Uses the simplest supported flow: a "checkout link" per plan (copied from
 * your Lemon Squeezy dashboard — Store > Products > [product] > Share), with
 * query params appended to prefill the buyer's details and attach custom
 * data linking the purchase back to your local user record.
 *
 * PRICING MODEL: two plans, same 40% first-time-customer discount on both:
 *   - Single Keyword/Account: $50/mo, 40% off first payment (→ $30)
 *   - Multiple Keywords/Accounts: $100/mo, 40% off first payment (→ $60)
 *
 * Because both plans use the SAME percentage, one discount code covers
 * both — set it up once in your dashboard:
 *   Store > Discounts > New Discount
 *     - "FIRST40": 40% off, store-wide (applies to all products),
 *       restricted to "New customers only"
 *   Lemon Squeezy enforces "new customers only" server-side, so the code
 *   can't be reused or abused by editing the URL. Put the code in
 *   LEMONSQUEEZY_FIRST_ORDER_DISCOUNT_CODE in .env.
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

  // Same 40% discount applies to both plans, so this is a single shared code.
  const discountCode = process.env.LEMONSQUEEZY_FIRST_ORDER_DISCOUNT_CODE;
  if (discountCode) {
    url.searchParams.set('checkout[discount_code]', discountCode);
  }

  // Send the buyer back to your success page after payment completes.
  // This is a fallback — also set the same URL as the product's default
  // "Redirect URL" in Lemon Squeezy's dashboard (Product > Checkout tab),
  // since that's the setting Lemon Squeezy is guaranteed to honor even if
  // this query param behavior changes.
  if (process.env.SENTRYVO_SITE_URL) {
    url.searchParams.set('checkout[redirect_url]', `${process.env.SENTRYVO_SITE_URL}/success.html`);
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
