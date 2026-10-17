# SentryVo — how the system works right now

Keep this file current whenever scanner, reporting or email behaviour changes.
(Last updated: 2026-10-17)

## Scanning (server/scanner.js, daily cron 08:00)
- Serper.dev Google search, `num: 100` (paid credits). Text queries per alias, plus Telegram (`t.me`) and a rotating slice of known leak sites. Image queries on Google Images.
- **Relevance rules**
  - Web results: alias must be in the page URL or title (NOT Google's snippet). Matching ignores spaces, dashes, underscores, case; each field checked separately.
  - Google Images results: if the client has fingerprints, only a photo match counts (distance <= 5 of 64 bits, `FINGERPRINT_MAX_DISTANCE`); otherwise alias in URL/title.
  - Rescue pass: non-matching pages are opened and their preview images fingerprinted.
  - Search-result/tag pages (`/search/`, `?s=`, ...) are NOT reported: the page is opened and only items whose link/title names the client are saved (`source = search_expand`). `/join/`-style links are skipped.
  - Page-crawl expansion on known sites only claims media whose own URL names the client.
- **Own content is never reported:** a result is skipped if its host equals, or is any subdomain of, the host of one of the client's original links (e.g. original `onlyfans.com/x` also covers `cdn.onlyfans.com`). One-way only. Already-saved `found`/`manual_review` leaks that match are set to `dismissed` on the next scan. **Company families** (constants.js `OWN_DOMAIN_FAMILIES`): an original link on any domain of a family covers the whole family — pornhub.com/.org/.net, phncdn.com, modelhub.com; chaturbate.com + highwebmedia.com. Extra families via Render env `OWN_DOMAIN_FAMILIES_EXTRA` (JSON array of arrays). Other cross-domain CDNs (e.g. twimg.com for x.com) are NOT covered — add such links as original links.
- Fingerprints: dHash only, no images stored (`content_fingerprints`, max 300/client). Upload page: `admin-fingerprints.html`.
- Statuses: found -> reported / manual_review (major platforms) -> removed; `dismissed` = excluded everywhere.

## Takedowns
- Known sites: one consolidated email per domain. Unknown: per-link flow. Major platforms (Reddit, X, Instagram, ...) never emailed; flagged `manual_review` with the platform's own form link.

## Reports
- Client report email on plan cadence: multi = daily, single = every 3 days, **admin-added (source `fiverr`) clients = daily** with a BCC copy to `ADMIN_DIGEST_EMAIL` (or `SMTP_USER`). 2-hour grace so daily reports are not skipped.
- `sendDailyReportEmail` throws if SMTP is not configured (no silent "success").

## Admin digest (daily, after the scan) — manual reporting
- One email to `ADMIN_DIGEST_EMAIL` listing, per client: (1) major-platform links with their report forms, (2) **every page/image found via Google (web, image, search_expand), to submit to Google's DMCA form**, plus an attached `.txt` of those links.
- Each leak is sent once (`admin_digest_sent_at`). Google TCRP was REJECTED, so submissions to Google are manual.

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

## Not built yet
Follow-up/escalation notices, cancellation handling from Lemon Squeezy (`subscription_cancelled/expired/payment_failed` are ignored), twice-daily scans for Multi plan.

## Design (2026-10 redesign)
- Shared tokens, fonts (Unbounded / Instrument Sans / Martian Mono), buttons and the Radar Sweep logo live in `style.css`; light by default, dark via `prefers-color-scheme`.
- Homepage-only sections and animations: `home.css` + `home.js` (classes prefixed `h-`). The real free scan still runs through `script.js` (`#free-scan-*` ids).
- Logo files: `assets/favicon.svg`, `assets/logo-mark.svg`, `assets/logo-icon.png` (512px app icon), `assets/logo-full.png` (1200×630 share image). `logo-nav.png` and `logo-full-trimmed.png` are no longer used.
