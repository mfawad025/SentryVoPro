# SentryVo: Functionality Overview & Comparison with BranditScan.com

*Last updated: 18 October 2026. BranditScan details come from their own pricing, benefits and comparison pages as indexed by search engines, their Trustpilot listing, and third-party reviews. Their headline numbers (e.g. "400M+ delistings", "98.7% detection") are their own unverified claims, and some reviews were published by competitors. Re-check their site before relying on any single figure.*

---

## 1. What SentryVo does today

### 1.1 Website
- Public pages: Home, Pricing, Agencies, Blog (3 articles), About, Contact, Terms, Privacy; account pages for register, login, password reset; creator and agency dashboards; admin pages.
- 2026 redesign: lilac / aubergine / rose palette with automatic dark mode, Radar Sweep logo, animated homepage (radar hero, live takedown demo, 72-hour case file, before/after slider, ticket-style pricing).

### 1.2 Free scan
- Real Google search (Serper.dev), top 3 results shown with a "+N more" teaser.
- **One free scan per visitor, ever**: salted hash of the IP plus a 1-year cookie; a site-wide daily cap protects Serper credits.

### 1.3 Plans and billing (Lemon Squeezy)
- Single Keyword/Account: $30 first month, then $50/mo, 1 keyword/platform, report every 3 days.
- Multiple Keywords/Accounts: $60 first month, then $100/mo, unlimited stage names, daily report.
- Agency Starter / Growth (self-serve) and Enterprise (contact sales), with a creator roster.
- **Full subscription lifecycle**: cancelled subscriptions keep scanning until the paid period ends; expired, unpaid and paused subscriptions stop scanning automatically; resumed ones restart. Agency creators follow their agency's subscription.

### 1.4 Finding leaks
- **Scan schedule**: every 6 hours on Multiple and agency plans, daily on Single (configurable).
- Google web + Google Images per alias, Telegram (`t.me`), Reddit/X, and a rotating sweep of known leak and tube sites.
- **Reverse image search (Google Lens)** once a day with the client's own photos (from their official pages and admin-added photo links), finding re-uploads that never mention their name.
- **Photo fingerprints** (64-bit dHash, up to 300 per client): resized, compressed, watermarked or flipped copies still match. Photos are deleted after hashing. Not facial recognition.
- **Verified matches only**: a result must name an alias in its address or title, or match the client's photos. Search/tag pages are opened and only matching items kept.
- **Own content never reported**: the client's official links, their subdomains and company families (e.g. Pornhub domains) are excluded.

### 1.5 Takedowns
- Real hosting provider and registrar abuse contacts via RDAP, plus a verified site-contact list; one consolidated notice per known site.
- Major platforms (Reddit, X, Instagram, ...) are flagged with their official copyright form instead of emailed.
- Reported links are rechecked and marked removed when they go down.
- **Google delisting is manual**: Google's partner program application was rejected, so every report links to Google's removal tool and the admin digest lists every Google result to submit.

### 1.6 Reporting and dashboard
- Email reports on plan cadence with an Excel attachment (full list, auto-reported, platform forms, Google delisting).
- Live dashboard per creator; agency dashboard with roster and per-creator stats.
- Daily admin digest of everything that needs a manual report.

### 1.7 Security (October 2026)
- Admin key on every admin route, the scan trigger and test email; constant-time key check.
- Rate limits on login, signup, password reset and forgot-password.
- All scraped text escaped in dashboards and emails; only http(s) links are clickable.

---

## 2. SentryVo vs. BranditScan

| | **BranditScan** | **SentryVo** |
|---|---|---|
| Price | Premium $69/mo, White Glove $149/mo, yearly plans, 50% off first month | Single $50/mo, Multiple $100/mo, 40% off first month, no yearly plan |
| Stage names | 3 on Premium (extras reportedly ~$5 each), unlimited on White Glove | 1 on Single, unlimited on Multiple |
| Scan frequency | Hourly (an older help article says daily) | Every 6 hours (Multiple / agency), daily (Single) |
| Photo detection | Facial recognition, catches cropped/edited photos | Reverse image search with the client's photos + photo fingerprints; no face data |
| Sources | Google, Reddit, Telegram, tube sites, forums, "50+ countries" | Google-indexed web and images, Telegram pages, Reddit/X, rotating leak-site list, Google Lens |
| Google delisting | Built in; a review says they are a Google partner (unconfirmed) | Manual, prepared for the admin |
| Fake / impersonator accounts | Advertised social media removal; reviews mention Instagram fakes removed | Not yet: major-platform leaks flagged for manual reporting only |
| Human help | White Glove concierge | None |
| False positives | Reviews mention unrelated or empty pages being flagged | Verified matches only; own pages excluded |
| Takedown routing | Not described in detail | Real host / registrar contacts via RDAP |
| Reports | Real-time dashboard | Dashboard + Excel report on schedule |
| Agencies | Small agencies on Premium | Agency plans with roster dashboard |
| Billing lifecycle | n/a | Cancel / expire / pause handled automatically |
| Trust | Trustpilot 4.5/5 (54 reviews), help center, "vs" comparison pages | No reviews, help center or comparison pages yet |
| Free offer | Free scan (Google + websites, no Telegram, per one review) | One free scan per visitor |

---

## 3. What's still missing (priority order)

**Done in October 2026:** scans every 6 hours on Multiple, daily reverse image search, subscription cancellation / expiry handling.

1. **Fake account (impersonator) search**: look for lookalike usernames on Instagram, X, TikTok and Telegram and list them in the dashboard with each platform's report form.
2. **Google delisting**: reapply to Google's copyright removal partner program once there is a track record; meanwhile show each link's delisting status in the creator's dashboard.
3. **More stage names on Single**: 2-3 instead of 1, to compete with Premium's 3 at $69.
4. **Yearly billing** at about 2 months free.
5. **Managed top plan** (~$150-$200) with a person handling fake accounts, escalations and check-ins.
6. **Follow-up / escalation notices** when a host ignores a takedown.
7. **Reviews**: ask satisfied clients for Trustpilot reviews.
8. **Help center and comparison pages** ("SentryVo vs BranditScan", "vs Rulta") for search traffic.
9. **Free tools** (e.g. a DMCA notice generator) as lead magnets.
10. **Hourly scans** if Serper credits allow (set `SCAN_INTERVAL_HOURS_MULTI=1`).

### Running cost note
Each scan costs Serper credits (roughly 3-6 queries per alias, plus up to 4 Google Lens queries per client per day). Moving Multiple clients from daily to every 6 hours multiplies their search cost by about 4. Watch the Serper dashboard after deploying and adjust `SCAN_INTERVAL_HOURS_MULTI` / `LENS_IMAGES_PER_DAY` if needed.

---

## Sources
- [BranditScan pricing](https://branditscan.com/pricing), [benefits](https://branditscan.com/explore-benefits), [home](https://branditscan.com/), [vs Rulta](https://branditscan.com/compare/branditscan-vs-rulta), [plans help article](https://branditscan.zendesk.com/hc/en-us/articles/22484090841236-What-plans-are-available)
- [BranditScan on Trustpilot](https://www.trustpilot.com/review/branditscan.com)
- Reviews: [OFM Tools](https://ofm-tools.com/branditscan-review/), [Fanlock](https://fanlock.com/blog/compare/branditscan-review), [Traqeer (competitor)](https://traqeer.com/compare/traqeer-vs-branditscan), [SourceForge](https://sourceforge.net/software/product/BranditScan/), [Ceartas (competitor)](https://www.ceartas.io/blog/top-content-removal-services)
