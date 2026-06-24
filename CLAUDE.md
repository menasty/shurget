# Shurget — AI-Powered Pickup Truck Delivery

## What this app does
Shurget connects customers needing to move oversized items (sofas, mirrors, dressers, appliances) with nearby pickup truck drivers for same-day delivery. Customers book through the web app, get an instant upfront price, and are matched with a driver in minutes.

## Stack
Express.js + EJS + PostgreSQL (Neon) + Render

## Directory map
- `server.js` — Express entry point; route mounts only
- `routes/` — API route groups (booking.js, drive.js, webhooks.js, driver.js, contact.js, partners.js, referral.js, embed.js, seo.js, reviews.js, admin.js, payouts.js, sms.js, disputes.js, orders.js)
- `middleware/` — Auth middleware (session.js = signed-cookie admin sessions)
- `db/` — Database access (index.js = pool, orders.js = order queries, drivers.js = driver queries, partners.js = partner queries, referrals.js = referral code/redemption queries, ratings.js = driver rating queries, quote_requests.js = quote/partner lead queries)
- `services/` — Business logic (maps.js = geocoding, driver.js = driver matching, stripe.js = Checkout sessions, stripe-connect.js = Connect Express onboarding + transfers, rating-token.js = HMAC signed tokens for rating links, email.js = all Postmark transactional emails, sms.js = Twilio customer + driver notifications, opt-out handling)
- `jobs/` — Background workers run by polsia.toml crons (review-email-worker.js = post-delivery review email sender)
- `views/` — EJS templates (layout.ejs, booking.ejs, confirmation.ejs, contact.ejs, partners.ejs, embed-quote.ejs, partners-embed.ejs, partner-apply.ejs, partner-login.ejs, partner-dashboard.ejs, partner-magic-sent.ejs, partials/)
- `public/css/` — Styles (theme.css = design tokens, seo-pages.css = SEO pages, booking.css = booking flow)
- `public/js/` — Booking flow JS (booking.js)
- `public/widget.js` — Embeddable "Shurget it" quote widget for retailer product pages
- `lib/` — Utilities (landing-context.js)
- `migrations/` — PostgreSQL schema changes (SQL files)
- `docs/` — Partner integration docs (retailer-integration.md)

## Database
- **orders** — id, item_type, pickup/dropoff addresses + coords, distance_miles, customer info, price breakdown (base/fee/total), status, driver_id/driver_status (driver job flow), driver match (name/phone/eta), driver_lat/lng/updated_at (real-time location), created_at, confirmed_at, stripe_session_id, paid_at, referral_code_used, referral_discount_cents, partner_slug (widget attribution), stripe_transfer_id (Connect payout), payout_status (pending|paid|failed|na), scheduled_review_email_at/review_email_sent_at (post-delivery review email scheduling), sms_consent/sms_unsubscribed (opt-in SMS notifications, TCPA compliance), claim_hold_expires_at/claim_hold_driver_id (60s soft-claim hold for race-safe self-service job claim), utm_source_first/utm_medium_first/utm_campaign_first (first-touch UTM from landing cookie), utm_source_last/utm_medium_last/utm_campaign_last (last-touch UTM at booking submit)
- **order_items** — id, order_id (FK), description, quantity, length_in/width_in/height_in (inches); populated per order for item-level detail
- **order_events** — id, order_id (FK), status, message, created_at; chronological status-history events for tracking page timeline
- **driver_applications** — id, name, email, phone, vehicle_type, city, status, created_at, reviewed_at, vehicle_insurance_doc, driver_license_doc, vehicle_registration_doc, background_check_consent, background_check_status ('pending'|'cleared'|'failed'), background_check_id, stripe_account_id (Connect Express), referral_code (auto-generated 8-char on activation), referred_by_driver_id (FK self), referral_bounty_paid_at/transfer_id ($50 paid when referred driver hits 3 hauls), utm_source/utm_medium/utm_campaign (recruitment attribution); status is `active` (matching pool) or `pending`
- **stripe_webhook_events** — id, event_id (unique), event_type, order_id, payload (JSONB), processed_at
- **quote_requests** — id, name/email/phone, item_description, pickup/dropoff addresses, lead_type ('quote'|'partner'), company_name, monthly_volume, zip_codes_served, status, created_at, reviewed_at
- **partner_applications** — id, store_name, website_url, contact_name/email/phone, monthly_volume, zip_codes_served, item_description, status (pending|approved|rejected), reviewed_at, reviewed_by, created_at
- **partners** — id, slug (unique, used as partner_slug in orders), store_name, website_url, contact_email, commission_rate (default 10%), stripe_account_id, commission_balance_cents, last_payout_at/amount_cents, created_at/updated_at
- **referral_codes** — id, code (8-char unique), owner_email, created_at, uses_count, max_uses (NULL = unlimited; 1 for single-use credit codes)
- **referral_redemptions** — id, code_id (FK), referee_email, order_id (FK), redeemed_at, credit_amount (cents)
- **driver_ratings** — id, order_id (FK unique), driver_id (FK), rating 1-5, comment, source ('email'|'web'), token_used (HMAC token for idempotency), created_at
- **driver_rating_disputes** — id, order_id (FK unique), driver_id (FK), rating, comment, reason, status ('pending'|'under_review'|'overridden'|'dismissed'), admin_notes, resolved_at, created_at; drivers can contest ratings from the /rate page, admin reviews at /admin/disputes
- **driver_waitlist** — id, email, pickup_zip, dropoff_zip, item_type, notified_at, created_at; captures customers when no drivers are available so they can be notified later

- Twilio (SMS notifications via TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_FROM env vars; ADMIN_PHONE env var for admin alerts; opt-out via POST /api/sms/inbound — TCPA STOP handling)
- Postmark (transactional email — POSTMARK_SERVER_TOKEN env var)
- OpenRouteService (geocoding, via ORS_API_KEY env var; fallback: zip-based estimation)
- OpenAI (future AI features, via OPENAI_API_KEY)
- Stripe (Stripe Checkout for customer payments + Connect Express for driver payouts — STRIPE_SECRET_KEY env var; orders go to `pending_payment` → `paid` after checkout; drivers onboard via `/driver/payouts`, transfers fire on delivery at 85% of order total)
- Google Analytics 4 (GA4_MEASUREMENT_ID env var; set to G-XXXXXXXXXX for shurget.com — tracks booking funnel, driver onboarding, /contact, /pricing; no-ops if unset)
- Polsia R2 (future image uploads)

## Recent changes
- (2026-06-19) Full rebrand: Haulr → Shurget — all copy, emails, SMS, URLs, legal pages, SEO pages, widget, sitemap, and admin panel updated. Deploy target: shurget-5.polsia.app.
- (2026-06-19) Referral attribution fix — migration 1752000000 adds `referred_by_driver_name` to driver_applications (denormalized at submission time); `db/drivers.js` `createDriverApplication` now captures referrer name; `getDriverApplications` drops fragile self-join; EJS uses `referred_by_driver_name` directly; `/admin/drivers` shows referral source reliably.
- (2026-06-18) Mobile-first driver portal + self-service claim — migration 1750900000 adds `claim_hold_expires_at`/`claim_hold_driver_id` to orders; race-safe 60s soft-claim with DB-level `UPDATE ... WHERE`; `db/orders.js` gains `claimJob`, `confirmClaim`, `releaseExpiredClaims`, `markJobArrived`, `markJobLoaded`, `markJobDelivered`; `routes/driver.js` adds `/claim`, `/confirm`, `/arrived`, `/loaded`, `/deliver` endpoints; `driver-jobs.ejs` rebuilt mobile-first with claim countdown bar, payout breakdown, one-tap Active Jobs status buttons (En Route → Arrived → Loaded → Delivered), jobs sorted by payout desc.
- (2026-06-18) Lifecycle order status emails — migration 1750850000 adds `status_emails_sent` JSONB column to orders for idempotency; `db/orders.js` gains `markStatusEmailSent()` + `wasStatusEmailSent()`; all 5 email types (driver_assigned, en_route, delivered, cancelled, payment_failed) now fire from `routes/admin.js` dispatch actions + `routes/driver.js` + `routes/orders.js` with idempotency guards.
- (2026-06-18) Customer dashboard enhancements — no-driver waitlist capture; `/notify` + `/help` + `/404` + `/error` pages; payment failure email on Stripe `async_payment_failed`/`expired` webhooks; `db/waitlist.js` + migration 1751000000.
- (2026-06-19) Driver portal self-service — migration 1750800000 adds `background_check_status`/`driver_rating_disputes` table; `/driver/disputes` + `/driver/dispute/new`; `/admin/disputes` with override/dismiss; BG check badge in driver-jobs; `sendDriverNewJobAlert()` email.