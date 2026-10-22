# SentryVo — how the system works right now

Keep this file current whenever scanner, reporting or email behaviour changes.
(Last updated: 2026-10-18)

## Scan schedule (server/cron.js + scanner.js)
- Hourly check (`SCAN_CHECK_CRON`, default `7 * * * *`). A client is scanned when their interval has passed since `users.last_scan_at`: Multiple and agency plans every `SCAN_INTERVAL_HOURS_MULTI` (6) hours, Single every `SCAN_INTERVAL_HOURS_SINGLE` (24). 20-minute grace. Runs never overlap.
- `/api/scan/run-now` and `npm run scan-now` scan everyone regardless of schedule.
- `/api/admin/schedule-status?key=ADMIN_KEY` shows the last hourly check, whether a scan run is in progress, and each active client's last/next scan and report.
- Every hourly check logs `Scan check: X of Y active client(s) due.` A run going longer than 3 hours is treated as stuck and no longer blocks new checks; Serper requests time out after 30 s.
- `/api/cron/tick?key=ADMIN_KEY` runs the same check as the hourly cron (due clients only, plus the daily admin digest). On a host that sleeps when idle (Render free plan), have cron-job.org call it every hour; otherwise nothing runs automatically.
- Admin digest: once a day, after the first check at or after `ADMIN_DIGEST_HOUR` (8, server time).
- Report emails are unchanged (plan cadence via `report_frequency_days`).

## Reverse image search (Google Lens)
- Once a day per client (`users.last_lens_at`), up to `LENS_IMAGES_PER_DAY` (4) of their photos go to Serper `/lens`, rotating through the list daily.
- Photos: `reference_images` table (admin: `GET /api/admin/reference-images?userId=`, `POST .../add?userId=` body `{urls:[...]}`, `GET .../clear?userId=`, all with the admin key) plus the preview images of the client's first 3 original links.
- A result is kept only if it names an alias in URL/title, or its picture matches the searched photo or a stored fingerprint. Lens matches are stricter than other searches: distance <= 3 bits (`LENS_MAX_DISTANCE`), compared on the full-size picture when Lens gives one, and pictures under 150 px are ignored (Lens also returns merely similar-looking pictures). Saved with `source = 'serper_lens'`, shown as "Reverse image", included in the admin digest. Not facial recognition.

## Scanning (server/scanner.js)
- Serper.dev Google search, `num: 100` (paid credits). Text queries per alias, plus Telegram (`t.me`) and a rotating slice of known leak sites. Google Images queries use the same leak terms as web (`"alias" leaked`, `"alias" nude`).
- **Relevance rules**
  - Web results: alias must be in the page URL or title (NOT Google's snippet). Matching ignores spaces, dashes, underscores, case; each field checked separately.
  - Google Images results: if the client has fingerprints, only a photo match counts (distance <= 5 of 64 bits, `FINGERPRINT_MAX_DISTANCE`); otherwise alias in URL/title.
  - Rescue pass: non-matching pages are opened and their preview images fingerprinted.
  - Search-result/tag pages (`/search/`, `?s=`, ...) are NOT reported: the page is opened and only items whose link/title names the client are saved (`source = search_expand`). `/join/`-style links are skipped.
  - Page-crawl expansion on known sites only claims media whose own URL names the client.
  - **Big-platform profile pages** (x.com/name, instagram.com/name, tiktok.com/@name, reddit.com/user/name, youtube.com/@name, facebook.com/name, ...; `profileHandle` in constants.js) are kept only if the account's username contains one of the client's names (fake/impersonation account) or a photo matched. A profile titled with a post that merely mentions the client is not a leak. Individual posts (`/status/`, `/p/`, `/comments/`, ...) follow the normal rules. Saved `found`/`manual_review` links that fail today's rules are dismissed on the next scan.
- **Own content is never reported:** a result is skipped if its host equals, or is any subdomain of, the host of one of the client's original links (e.g. original `onlyfans.com/x` also covers `cdn.onlyfans.com`). One-way only. Already-saved `found`/`manual_review` leaks that match are set to `dismissed` on the next scan. **Company families** (constants.js `OWN_DOMAIN_FAMILIES`): an original link on any domain of a family covers the whole family — pornhub.com/.org/.net, phncdn.com, modelhub.com; chaturbate.com + highwebmedia.com. Extra families via Render env `OWN_DOMAIN_FAMILIES_EXTRA` (JSON array of arrays). Other cross-domain CDNs (e.g. twimg.com for x.com) are NOT covered — add such links as original links.
- Fingerprints: dHash only, no images stored (`content_fingerprints`, max 300/client). Upload page: `admin-fingerprints.html`.
- Statuses: found -> reported / manual_review (major platforms) -> removed; `dismissed` = excluded everywhere.
- **Big-platform links need the admin's approval** before the client sees them: `manual_review` with `leaks.approved_at` NULL is hidden from the client's report, dashboard and counts (`CLIENT_VISIBLE` in db.js). Approving from the digest sets `approved_at`; the link then appears in the client's next report. Links that existed when this was added were marked approved.

## Takedowns
- Known sites: one consolidated email per domain. Unknown: per-link flow. Major platforms (Reddit, X, Instagram, ...) never emailed; flagged `manual_review` with the platform's own form link.

## Reports
- Client report email on plan cadence: multi = daily, single = every 3 days, **admin-added (source `fiverr`) clients = daily** with a BCC copy to `ADMIN_DIGEST_EMAIL` (or `SMTP_USER`).
- **Fixed send time:** a report is due on its calendar day (`report_frequency_days` after the last one) from `REPORT_HOUR` (default 9) in `REPORT_TIMEZONE` (default Asia/Karachi), so it arrives at the same time every day; a report a day or more late goes out at the next hourly check. A client whose report is due is scanned first if their last scan is over 2 hours old. Reports are also sent for clients that didn't need a scan in that check. (The old rule, "24 h minus 2 h after the last report, at the next scan", made the time drift.)
- `sendDailyReportEmail` throws if SMTP is not configured (no silent "success").

## Admin digest (daily) — manual reporting
- Sent **every day**, also when there are no new links, at the first hourly check from `ADMIN_DIGEST_HOUR` (default = `REPORT_HOUR`) in `REPORT_TIMEZONE`, after that check's scans and reports. The day it was sent is stored in `app_state` (`admin_digest_day`), so restarts neither repeat nor skip it. A missing daily email therefore always means something is wrong.
- Top: **Your clients** table (last scan, last report, links found in 24 h) with warnings: scan overdue, report due but not sent, searches failed in the last scan (Serper credits).
- Then the links, per client, in three lists, each link with its button beside it:
  1. **Web links** (Google Search pages: `serper_web`, `search_expand`) → "Report to Google" (Google DMCA form).
  2. **Google Images links** (`serper_image`, `serper_lens`) → "Report to Google"; shows the page and the image file.
  3. **Big platforms** (`manual_review`) → "Report on <platform>" (that platform's copyright form).
- Under each link: **Why** it was flagged (name in address / name in page title + the title / photo match / reverse image / site search page) and a **Not a leak** button; big-platform links also get **Approve**. The buttons open `/api/leak-action` (signed per leak and action with `ADMIN_SECRET_KEY`, no admin key in the email), which shows a confirm page; the change happens only on its POST button, so mail scanners opening links can't trigger it. Not a leak = `dismissed`.
- Attached `.txt` has the Google links grouped into web and image sections. Each leak is sent once (`admin_digest_sent_at`), except big-platform links waiting for approval, which are repeated daily until approved or dismissed. Google TCRP was REJECTED, so submissions to Google are manual.
- Join / sign-up / redirect pages (`/join`, `/signup`, `/go`, `/out`, ...) are never saved or reported: they hold no copyrighted content, so a DMCA notice for them would be invalid.

## Admin endpoints (all need `?key=ADMIN_SECRET_KEY`)
- `/api/admin/send-report?email=&scan=1` — send a client's full report now.
- `/api/admin/send-digest-now[?all=yes]` — send the admin digest now (`all=yes` = re-send everything not yet marked submitted to Google).
- `/api/admin/leak-debug?email=[&dismiss=ids]` — inspect / dismiss leaks.
- `/api/admin/google-delist?userId=` and `POST .../mark` — per-client Google list; `admin-google-delist.html`.
- `/api/scan/run-now` and `/api/test-email` also need the admin key now (either `?key=` or an `X-Admin-Key` header).

## Free scan (homepage)
- One free scan per visitor, ever: `free_scans` table keyed by a salted SHA-256 of the IP (`FREE_SCAN_SALT`), plus a 1-year `sv_free_scan_used` cookie. Failed searches give the scan back. Site-wide daily cap `FREE_SCAN_DAILY_SITE_CAP` still applies.
- Known limits: visitors sharing one IP (office, some mobile carriers) share one free scan; a VPN plus cleared cookies gets another.

## Security
- Login/reset: 10 attempts per 15 min per IP. Register/forgot-password: 10 per hour per IP. Passwords min 6 characters everywhere.
- Dashboards, agency dashboard, free-scan results and report emails escape all scraped text and only link `http(s)` URLs.

## Billing (Lemon Squeezy webhook)
- Every `subscription_*` event updates the account from the subscription's status: active / on_trial / past_due / cancelled keep `users.status = 'active'` (cancelled keeps scanning until `subscription_ends_at`); paused -> 'paused'; expired / unpaid -> 'expired'. Only 'active' accounts are scanned.
- Account found by `custom_data.user_id` (checkout_ref) or by `ls_subscription_id`. Agency owner changes are applied to their creators too.
- Invoice events (`subscription_payment_*`) are logged only; Lemon Squeezy follows up with `subscription_updated`.
- Subscribe the webhook to: order_created, subscription_created, subscription_updated, subscription_cancelled, subscription_resumed, subscription_expired, subscription_paused, subscription_unpaused.

## Not built yet
Follow-up/escalation notices, impersonator (fake account) search, managed top plan.

## Design (2026-10 redesign)
- Shared tokens, fonts (Unbounded / Instrument Sans / Martian Mono), buttons and the Radar Sweep logo live in `style.css`; light by default, dark via `prefers-color-scheme`.
- Homepage-only sections and animations: `home.css` + `home.js` (classes prefixed `h-`). The real free scan still runs through `script.js` (`#free-scan-*` ids).
- Logo files: `assets/favicon.svg`, `assets/logo-mark.svg`, `assets/logo-icon.png` (512px app icon), `assets/logo-full.png` (1200×630 share image). `logo-nav.png` and `logo-full-trimmed.png` are no longer used.

## Sales partner referrals (Lemon Squeezy affiliates)
- Store `mfawad442`. Every public page loads Lemon Squeezy's `affiliate.js`. Partner links look like `https://www.sentryvo.com/?aff=CODE`.
- `script.js` also keeps the code in localStorage for 60 days (`sv_referral`), so it survives ad blockers, and prefills the optional "Referral code" box on both sign-up forms.
- The server adds `aff=CODE` to the Lemon Squeezy checkout URL (`lemonsqueezy.js`) and saves it in `users.referral_code`. Lemon Squeezy calculates and pays the commission.
- Keep `REFERRAL_DAYS` in `script.js` equal to the cookie length set in Lemon Squeezy.
