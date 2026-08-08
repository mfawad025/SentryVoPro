# SentryVo Backend

Handles:
1. **Registration** — name, email, password, plan, platform(s), stage-name
   aliases, and links to the creator's own original content (proof of
   ownership — not the infringing link).
2. **Lemon Squeezy checkout** — redirect-based hosted checkout, no card data
   ever touches this server.
3. **Daily scanning** — searches Google (web + images) for each subscriber's
   aliases, attempts best-effort DMCA takedown notices, rechecks previously
   reported leaks for removal.
4. **Email reports** — sent on each subscriber's plan cadence (daily for
   Multi-Platform, every 3 days for Single Platform).

## Free scan tool (public homepage)

The hero section has a real, working free-scan box — no login required.
It's a genuine Google Custom Search query, not a mockup, so it draws from
the same quota as your daily subscriber scans. Two layers of protection:

- **Per visitor**: 3 scans per IP per day
- **Site-wide**: a hard cap across *all* visitors combined (default 25/day,
  set via `FREE_SCAN_DAILY_SITE_CAP` in `.env`) — this exists so a burst of
  anonymous traffic can't eat the quota your paying subscribers depend on

Only the top 3 results are shown publicly (with a "+N more found" teaser)
— the full list is a subscriber-only feature via the dashboard.

## Plans

| Plan | First order | Then | Keywords/accounts covered | Report cadence |
|---|---|---|---|---|
| Single Keyword/Account | $30 | $50/mo | Exactly one | Every 3 days |
| Multiple Keywords/Accounts | $80 | $100/mo | Two or more | Daily |

The first-order discount is a Lemon Squeezy discount code (see setup below),
not a separate product — Lemon Squeezy enforces "new customers only"
server-side, so it can't be reused by re-visiting the checkout link.

## Setup

```bash
cd server
npm install
cp env.example.txt .env
```

### Lemon Squeezy

1. Create a store at lemonsqueezy.com if you haven't already.
2. Create two products: "Single Keyword/Account" ($50/mo) and "Multiple Keywords/Accounts" ($100/mo).
3. On each product, click **Share** and copy the checkout link into `.env`
   as `LEMONSQUEEZY_CHECKOUT_URL_SINGLE` / `LEMONSQUEEZY_CHECKOUT_URL_MULTI`.
4. Go to **Settings > Webhooks**, add a webhook pointing at
   `https://<your-deployed-backend>/api/lemonsqueezy/webhook`, and subscribe
   it to at least `order_created` and `subscription_created`.
5. Copy the signing secret Lemon Squeezy gives you into
   `LEMONSQUEEZY_WEBHOOK_SECRET`.
6. **Set up the first-order discount**: Dashboard > Discounts > New Discount
   — $20 off, restricted to "New customers only." Copy the discount code
   into `LEMONSQUEEZY_FIRST_ORDER_DISCOUNT_CODE`.
7. Test in Lemon Squeezy's **Test mode** first — you can simulate webhook
   events and discount redemption from a test subscription without a real card.

No Lemon Squeezy API key is required for this flow — the checkout link +
webhook secret is all you need. (An API key would only be needed if you
later want to generate checkouts dynamically instead of via query params,
or build a customer portal integration.)

### Google Custom Search, Email

Same as before — see the comments in `env.example.txt`. If left
unconfigured, scans log a warning and skip, and report emails print to the
console instead of sending, so you can still test the rest of the flow.

## Run locally

```bash
npm start
```

Test registration by POSTing to `/api/register`, or use `register.html`
pointed at this server. Test the scan pipeline directly:

```bash
npm run scan-now
# or, with the server running:
curl -X POST http://localhost:4242/api/scan/run-now
```

## Excel reports

Every periodic email now includes an `.xlsx` attachment (`excelReport.js`,
via the `exceljs` package) with two tabs: a full leak list (URL, hosting
provider, status, timestamps, and a manual-Google-removal link for anything
not yet confirmed removed), and a summary tab. No setup needed — this works
as soon as `nodemailer`/SMTP is configured.

## Hosting-provider lookup (RDAP)

`hostLookup.js` looks up the actual hosting provider and registrar abuse
contacts for each leaked URL via RDAP (the free, no-API-key WHOIS
replacement) — both the domain's registrar and the IP's network operator.
Takedown notices go to whatever abuse addresses RDAP finds, falling back to
the old `abuse@<hostname>` guess if RDAP has nothing. This was marked
optional in the spec because **RDAP data completeness varies a lot by
registry** — some registrars/hosts publish rich abuse contacts, many don't,
so treat results as a genuine improvement over guessing, not a guarantee.

## About "automated Google reporting"

Worth being direct about this one: **Google does not provide a public API
for third parties to submit copyright removal requests.** Their "Remove
content from Google" tool (reportcontent.google.com) is a web form, and
automating actual submission would mean scripting a login-gated form —
fragile, and against Google's terms of service. So this is **not**
automated. Instead, every leak that isn't yet confirmed removed gets a
ready link to Google's manual removal tool in both the email report and the
Excel export, so submitting takes seconds instead of research time. If you
later become a large-enough rights holder, Google does offer a proper
Content ID-style program for high-volume partners — that's a business
relationship you'd set up directly with Google, not something this codebase
can wire up for you.

## What's real vs. best-effort here

- **Finding leaks**: real, via Google Custom Search (both web and image
  search). Text-based and reverse-lookup-by-description only — it won't
  recognize a leaked photo by its pixels the way a reverse-image or facial
  recognition API would. That's a future upgrade, not a rewrite — add
  another search function next to `googleSearch.js` and call it from
  `scanner.js`.
- **Filing takedowns**: looks up real abuse contacts via RDAP where
  possible, falls back to a guessed `abuse@<hostname>` otherwise, and emails
  a templated DMCA notice either way. Many hosts don't monitor either
  address or require a web form instead — treat "reported" as "attempted,"
  not "delivered and acted on."
- **Confirming removal**: a simple HTTP status recheck. A signal, not proof.
- **Google delisting**: manual, by design — see above. Not automated.
- **Payment → active account**: depends entirely on the Lemon Squeezy
  webhook actually reaching your server and the signature verifying. Test
  this thoroughly in Lemon Squeezy's test mode before going live — if the
  webhook URL is wrong or the server is down when it fires, accounts will
  stay stuck on `pending_payment` forever with no automatic retry path
  beyond Lemon Squeezy's own retry window.

## Deployment notes

- Needs real Node hosting (Render, Railway, a VPS) — not GitHub Pages.
- **SQLite is local to the server's filesystem.** Free tiers on hosts like
  Render wipe local disk on redeploy. For real subscribers, swap `db.js`'s
  connection for a hosted Postgres (Supabase/Neon both have free tiers) —
  the SQL is plain enough to translate directly.
- Keep the server **always-on** (not a free tier that sleeps) or the daily
  cron job won't fire reliably. Alternative: use an external cron service
  (e.g. cron-job.org, free) to hit `/api/scan/run-now` on a schedule instead
  of relying on `node-cron` inside a sleeping process.
- Watch your Google Custom Search quota (100 free queries/day) — the query
  count per subscriber scales with how many aliases and platforms they have,
  so budget accordingly as you grow.
