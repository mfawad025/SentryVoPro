# SentryVo — Functionality Overview & Comparison with BranditScan.com

*Prepared as a working reference document. Numbers/claims about BranditScan reflect what was publicly visible on their site at time of research — verify anything you plan to rely on directly with a fresh look at their current site, since SaaS products change.*

---

## 1. What SentryVo Currently Does

### 1.1 Public / Marketing Site
- 11 pages: Home, Pricing, Register, Login, Dashboard (preview), About, Contact, Terms, Privacy, Success, Failure
- Minimal & premium design with glassmorphism (frosted-glass cards, blurred color glow behind content)
- Dark navy + blue color scheme, matched directly to your logo's exact colors
- Fully responsive layout, mobile nav

### 1.2 Free Scan Tool (Home Page)
- Real, working — not a mockup. Visitor types a name/username, it runs a live Google Custom Search query server-side and returns actual results
- Rate-limited two ways: 3 scans per visitor per day (by IP), and a site-wide daily cap (default 25) to protect your Google API quota from abuse
- Shows top 3 results with a "+N more found" teaser driving toward signup

### 1.3 Registration & Onboarding
- Two-tier plan selection:
  - **Single Keyword/Account** — $50/mo ($30 first order)
  - **Multiple Keywords/Accounts** — $100/mo ($80 first order)
- Platform picker: OnlyFans, Fansly, Chaturbate, ManyVids, Fancentro, PornHub, plus a manual **"Other"** option (name + link) for anything not listed
- Captures: full name/stage name, email, mobile, password, aliases to monitor, and links to the creator's **own** original content (proof of ownership — explicitly separate from the infringing content the system finds automatically)

### 1.4 Payment (Lemon Squeezy)
- Hosted checkout — card details never touch your server, only Lemon Squeezy's page
- First-order discount applied automatically via a Lemon Squeezy discount code restricted to new customers (can't be gamed by revisiting the URL)
- Webhook-based activation: `order_created`/`subscription_created` events flip an account from `pending_payment` to `active`

### 1.5 Scanning Engine (Backend)
- Runs daily per active subscriber via a cron job
- Searches Google **both** as text (web) and as Google Images, per alias
- Builds platform-specific queries (e.g. `"alias" chaturbate leaked`) plus site-restricted checks against known leak-prone destinations (Reddit, Telegram, X, Tumblr)
- Deduplicates against previously found leaks (won't re-report the same URL)

### 1.6 Takedown Attempts
- For each new leak, looks up the actual hosting provider **and** domain registrar via RDAP (free WHOIS replacement) to find real abuse contacts
- Falls back to a guessed `abuse@<hostname>` address if RDAP has nothing
- Sends a templated DMCA notice automatically
- Rechecks previously "reported" leaks periodically — if the URL now 404s or redirects elsewhere, marks it "removed"
- **Google delisting is explicitly manual** — Google has no public API for third-party takedown requests, so every report includes a direct link to Google's removal tool instead of pretending to auto-submit

### 1.7 Reporting
- Email reports on a cadence tied to plan: every 3 days (Single), daily (Multi)
- Each email includes an **Excel (.xlsx) attachment** with two tabs: full leak list (URL, hosting provider, status, timestamps, manual-Google-removal link) and a summary tab

### 1.8 Dashboard
- **Important caveat, repeating this because it matters**: `dashboard.html` is currently a static mockup with example numbers. It is not yet wired to a logged-in user's real database records. This is the single biggest gap between "looks complete" and "is complete."

---

## 2. SentryVo vs. BranditScan.com

| Capability | SentryVo (current) | BranditScan |
|---|---|---|
| Automated web/text leak scanning | ✅ Yes (Google Custom Search) | ✅ Yes |
| Google Images scanning | ✅ Yes | ✅ Likely (unconfirmed exact method) |
| Reverse image search (find leaked *photos* by pixel match) | ❌ No | ✅ Yes |
| Facial recognition matching | ❌ No | ✅ Yes |
| Watermark detection | ❌ No | ✅ Yes |
| Automated DMCA notice generation/sending | ✅ Yes (best-effort, RDAP-sourced contacts) | ✅ Yes, more mature/established |
| Google delisting | ⚠️ Manual link only (honest limitation, not automatable via public API) | Marketed as handled — actual mechanism unconfirmed, may also rely on manual submission at scale, or a direct relationship with Google |
| Free public scan tool | ✅ Yes, real | ✅ Yes |
| Doxing / catfish / impersonation account protection | ❌ No | ✅ Yes |
| Fan-traffic redirect tool (redirect pirated-content visitors to your real page) | ❌ No | ✅ Yes |
| "Brand learning AI" (improves matching over time, multi-alias) | ⚠️ Partial — multi-alias supported, no learning/feedback loop | ✅ Yes |
| Free tools suite (DMCA notice generator, 2257 form generator, model release generator) | ❌ No | ✅ Yes |
| Pirate-site database / "Atlas"-style intelligence | ❌ No | ✅ Yes |
| Agency/studio pricing tier | ❌ No (dropped from scope) | ✅ Yes |
| Blog / resources / SEO content | ❌ No | ✅ Yes |
| Affiliate program | ❌ No | ✅ Yes |
| Developer API | ❌ No | ✅ Yes |
| Real customer testimonials / case studies | ❌ No (placeholders only, by design — see below) | ✅ Yes |
| Excel/report export of leak data | ✅ Yes | Unconfirmed |
| Payment | Lemon Squeezy | Unconfirmed, likely Stripe or similar |
| Pricing | $50/$100 (with first-order discount) | ~$69 Premium / ~$149 White Glove (as observed) |

**On the testimonials row**: this isn't a gap so much as a deliberate boundary — I built placeholder testimonials clearly marked as such rather than fabricating quotes attributed to real people, which would be a real problem (misrepresentation, potential defamation/right-of-publicity issues) regardless of competitive pressure. Real testimonials need to come from your actual customers, with their permission.

---

## 3. What's Missing / Where to Improve

### Tier 1 — Blocking issues (nothing works publicly without these)
1. **No real credentials anywhere** — every API key, checkout URL, and webhook secret is still a placeholder
2. **Nothing is deployed** — the backend doesn't exist on the internet yet
3. **Dashboard shows fake data** — needs wiring to real per-user database queries
4. **No real authentication/sessions** — login checks a password but doesn't gate access to anything; right now, knowing a URL is enough to see a dashboard

### Tier 2 — Real product gaps vs. BranditScan
5. **No reverse-image or facial recognition search** — this is BranditScan's core differentiator for *finding leaked photos*, and SentryVo currently only finds things Google can describe in text. This is the highest-leverage feature gap.
6. **No fan-traffic redirect tool** — a meaningful monetization angle (recovering lost subscriber revenue) that SentryVo doesn't attempt yet
7. **No doxing/impersonation account monitoring** — a real safety feature for the target audience that's currently absent
8. **No free tools suite** — BranditScan's DMCA generator, 2257 generator, etc. function as SEO/lead-gen magnets; SentryVo has none of these

### Tier 3 — Trust & credibility gaps
9. **No real testimonials or case studies** — necessary for conversion, but must be earned from actual customers, not fabricated
10. **No blog/resources/SEO content** — no organic discovery path beyond paid acquisition or word of mouth
11. **No comparison-table social proof** ("why us vs. competitor X") — BranditScan uses this; SentryVo doesn't yet have the track record to make these claims credibly

### Tier 4 — Operational gaps
12. **No admin panel** — you currently have no way to see all subscribers/leaks except querying the database directly
13. **SQLite on ephemeral hosting** — fine for testing, will silently lose data on Render free-tier redeploys; needs a real hosted database before real customers sign up
14. **No self-service billing portal link** — subscribers can't manage/cancel their own subscription from the dashboard yet (relies entirely on Lemon Squeezy's own portal, unlinked)
15. **Untested against real traffic** — every piece has been syntax-checked, none has run against a real Lemon Squeezy webhook, real RDAP responses at scale, or real user load

---

## 4. Suggested Priority Order

If the goal is "smallest path to a real, live product," roughly in order:

1. Deploy backend to Render with real credentials, confirm the full signup → payment → activation loop actually works end-to-end
2. Wire the dashboard to real data + add real login sessions
3. Move off SQLite to a hosted Postgres before accepting real paying customers
4. Add reverse-image search (single highest-value feature gap vs. BranditScan)
5. Everything else in Tier 2–4, roughly in the order listed, as budget and time allow

Want me to start on any of these? Wiring the dashboard to real data plus adding sessions is the most natural next step given everything else already exists.
