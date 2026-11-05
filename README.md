# BuzzCall (TryBuzzCall) — MVP

When a customer call is missed, we text the caller back, collect **name / need / callback window**, then **buzz the owner by SMS** with who/what and a tap-to-call link. Built for any appointment-based local business that books by phone, in any US state; home services (plumbing/HVAC) and hair braiders are the featured pilots. It does not do spam filtering.

## Platform and vendor workspaces

- `/admin`: platform administration using the existing admin credentials. Review and approve onboarding, create individual vendor accounts, assign phone lines, revoke access, and monitor vendor billing/payout status.
- `/vendor/login`: each shop owner's separate sign-in. `/vendor` shows only that shop's calls, leads, bookings, subscription and payouts; `/vendor/settings` edits its business settings.
- `/admin/legacy`: the original single-business workspace and records, still restricted to platform administrators. Existing customer, phone, payment and consent records are not silently assigned to a vendor.

See [Vendor workspaces](docs/VENDOR_WORKSPACES.md) for enrollment, routing, isolation and operating limits. Live card entry and payout onboarding remain on Stripe-hosted pages.

See [Admin workspace and payment pages](docs/ADMIN_WORKSPACE.md) for behavior and validation notes. Opening `/pay/mock/:id` no longer completes a simulated payment; an explicit same-origin POST is required. The payment return pages do not treat query strings as proof of payment. This redesign does not deploy the app or enable live payments/SMS.

## Stack
Node 20 + Express. Leads are stored in a JSON file (`data/db.json`), with no native dependencies. Uses the Twilio SDK, optional OpenAI (via fetch), and the Stripe SDK.

```
Caller ──call──▶ Twilio number ──POST /twilio/voice──▶ <Dial FORWARD_TO_PHONE>
                                   │ no-answer/busy ──▶ POST /twilio/voice/status
                                   ▼
                       <Gather numDigits=1> voice opt-in prompt (src/consent.js)
                                   │ caller presses 1 ──▶ POST /twilio/voice/consent (logged in db.voiceConsents)
                                   ▼
                       text-back SMS to caller (agent.firstMessage)
Caller ──SMS──▶ POST /twilio/sms ──▶ agent.handleReply (name → need → window)
                                   └─ when complete ──▶ BUZZ SMS to OWNER_PHONE
```

### Optional booking + deposit
With `BOOKING_ENABLED=1`, after the *need* step the caller gets the 3 next open slots (from `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BUSINESS_TZ`) and replies `1`/`2`/`3`, or `callback` to fall back to the classic callback-window flow.
- **No deposit** (`DEPOSIT_ENABLED` off): the slot is booked at once, the caller gets a confirmation, and the owner gets `BOOKED (no deposit)`.
- **Deposit** (`DEPOSIT_ENABLED=1`, `DEPOSIT_AMOUNT` default 49): the slot is *held* for `HOLD_MINUTES` and the caller gets a pay link. The owner gets `slot held, deposit pending`.
  - With `STRIPE_SECRET_KEY`, the link is a Stripe Checkout Session (mode `payment`, `metadata.bookingId`) charged on **BuzzCall's platform account** (separate charges + transfers — see *Stripe Connect* below). Payment events arrive on the platform webhook `{PUBLIC_BASE_URL}/stripe/webhook`.
  - **Connect optional for taking deposits:** if the shop has not connected payouts yet, the deposit is still collected and held; the vendor transfer stays pending until Connect onboarding finishes.
  - Without a key, the link is `{PUBLIC_BASE_URL}/pay/mock/:id`. Opening it is read-only; an explicit same-origin POST completes the simulation.
  - On payment the booking becomes `confirmed`, the caller gets a confirmation text, and the owner gets `BOOKED + PAID $49: name, need, slot, lead fee $12, tel:…`.
- **Per-paid-lead fee** (`LEAD_FEE`, default 12 USD): only when a caller books *and* pays the deposit. Recorded on the booking as `lead_fee` + `lead_fee_status` when it is marked paid:
  - `LEAD_FEE_WAIVED` **defaults ON** (pilot; only an explicit `0`/`false`/`off` disables it): no application fee; status `waived`, fee $0.
  - If enabled: recorded as `due` on the booking (may be invoiced or netted from payouts), capped at deposit − 1¢ **and** at ⌊deposit/3⌋ for bookkeeping.
  - Mock flow without Stripe keys and no mock connected account: status `due`. A payment that arrives after its slot was lost (`paid_conflict`) gets status `review`.
  - `/admin` shows the lead-fee total (due / collected / waived / review) and the fee on each booking.
- **Refunds / release:** admin Deposits view (`/admin/deposits`) can Refund (full refund to the customer; reverses a transfer if already paid out, else records `vendor_debt`) or Release now. No-show: morning-after SMS check; NO pauses payout.
- Files: `src/booking.js` (slots, holds, Stripe/mock links, direct-charge params, fail-closed skip, lead fees, mark-paid), `src/connect.js` (connected account state, onboarding, status, fee cap).
- Bookings live in `data/db.json` → `bookings`. A slot that is `held` (and not expired) or `confirmed` is never offered or booked again, and the hold is re-checked at pick time. Expired holds release the slot. A payment that arrives after expiry, when someone else has taken the slot, is flagged `paid_conflict` and the owner is told to reschedule or refund.
Files: `src/server.js` (routes), `src/billing.js` (shop subscription billing), `src/agent.js` (conversation; OpenAI if `OPENAI_API_KEY`, else plumber/HVAC templates), `src/sms.js` (Twilio or log-only), `src/store.js`, `public/index.html` (landing page and waitlist).

### Business types (`BUSINESS_TYPE`, see `src/trades.js`)
Each trade maps to one of two flows plus its own wording and defaults (services, days, hours, deposit, window length, urgent words):
- **appointments** (braiders, nails, lashes_brows, barber, hair_salon, makeup, esthetician, massage, pet_grooming, tutoring, photography): *name → service from the `SERVICES` menu (+ notes) → preferred day → start times or callback → optional deposit*. No urgent flag.
- **jobs** (plumbing, hvac, electrical, handyman, cleaning, landscaping, mobile_detailing, catering_bakery): *name → describe the need → next `SLOT_MINUTES` windows or callback → optional deposit*. Trade-specific urgent words add 🚨 to the owner alert.
- `other`: set `BUSINESS_FLOW=appointments|jobs` and `BUSINESS_TRADE_LABEL` (e.g. "Pool cleaning").
The /setup form writes `BUSINESS_TYPE`/`BUSINESS_FLOW`/`BUSINESS_TRADE_LABEL` into the admin config override. When `BUSINESS_TYPE` is empty the legacy keys below behave exactly as before.

### Legacy verticals (`VERTICAL`)
- `home_services` (default): plumber/HVAC wording (`BUSINESS_VERTICAL=plumber|hvac`), flow *name → need → slot*, fixed `SLOT_MINUTES` blocks, $49 deposit, $12 lead fee, urgent-keyword flag.
- `braiders`: warm stylist wording in first person, no urgent/emergency language. Flow: *name → style from the `SERVICES` menu (plus optional size/length notes) → preferred day → 3 start times → hold + deposit*. Each caller can also reply `call` for a callback instead.
  - `SERVICES="Knotless braids:360,Box braids:300,Locs retwist:120,Twists:180"` (name:minutes). Start times are spaced `SLOT_STEP_MINUTES` apart (default 60). The whole appointment must fit inside `BUSINESS_HOURS`, and a time is never offered if it overlaps a held or confirmed booking.
  - Defaults when the var is unset: `BUSINESS_HOURS=09:00-19:00`, `BUSINESS_DAYS=1,2,3,4,5,6` (Mon-Sat), `DEPOSIT_AMOUNT=50` (credited toward the service), `LEAD_FEE=5`. Explicit values always override, so remove the home-services values from `.env` when you switch.
  - Preferred day understands `today`, `tomorrow`, weekday names, `10/24`, `Oct 24`. Anything else (like `soonest`) means the earliest opening. If that day is full, the caller gets the closest openings after it.
  - `BOOKING_LINK` (optional): the stylist's own Booksy/StyleSeat/GlossGenius link, added to the time-offer and callback texts.
  - Owner texts: `BUZZ …: time held, deposit pending …`, then `BOOKED + PAID: <name>, <service>, <time>, $50 deposit. Notes: <size/length>. tel:…`.
  - Demo: `bash scripts/demo_braiders.sh`. If nothing is listening on `PORT` (default 3000), it starts a temporary braider server with Twilio/Stripe blanked, runs a booking + mock deposit and a callback, prints the SMS log, and stops the server. Only run one server against `data/` at a time.

## Run locally (demo, no keys needed)
```bash
cp .env.example .env
npm install
npm start                      # http://localhost:3000
bash scripts/demo_simulate.sh  # in a second terminal: booking + mock deposit, then the classic callback path
bash scripts/demo_billing.sh   # shop subscription lifecycle (mock Stripe; own temp server on :3077)
bash scripts/demo_braiders.sh  # braider flow (stop the server above first, or it will refuse if that server isn't VERTICAL=braiders)
```
SMS output goes to `data/sms.log` (bodies locally; metadata only in production) and a one-line, body-free summary to the console. Admin page: http://localhost:3000/admin (any username unless `ADMIN_USERNAME` is set, password `ADMIN_PASSWORD`; repeated wrong passwords lock the client out for 15 min).

**Production vs demo:** Render sets `NODE_ENV=production`. There, mock/demo behaviour (unsigned mock Stripe webhooks, Twilio webhooks without `TWILIO_AUTH_TOKEN`, `/pay/mock/*`, `/billing/mock/*`, mock checkout) is refused unless `DEMO_MODE=1`. With `STRIPE_SECRET_KEY` set, `/stripe/webhook` requires `STRIPE_WEBHOOK_SECRET` (503 without it). With `TWILIO_AUTH_TOKEN` set, every Twilio webhook must be signed for `PUBLIC_BASE_URL`. Every POST to `/admin/*`, `/api/billing/*` and `/billing/*` (mock billing included) needs a same-host `Origin` (or `Referer`) header, enforced by one central guard; browsers send it, scripts must add `-H "Origin: $BASE"`. Applying a setup that changes `OWNER_PHONE`/`FORWARD_TO_PHONE` asks for a second confirmation (`confirm_phones=1`). Opt-outs (STOP and friends, or "stop texting me") are stored and honoured before every send; an exact Twilio keyword is confirmed by Twilio, any other opt-out ("S T O P", "opt out", "please stop texting me") gets one confirmation from the app. Text-backs go only to US/Canada area codes (`TEXT_EXTRA_AREA_CODES` adds more), capped per line by `OUTBOUND_SHOP_MAX_PER_HOUR` (100) and `OUTBOUND_SHOP_MAX_PER_DAY` (300) (a vendor's own limit can be set in `/admin`; 0 = off) and across all lines by `OUTBOUND_MAX_PER_HOUR` (200) and `OUTBOUND_MAX_PER_DAY` (500). Cap alerts go to the platform admin (platform `OWNER_PHONE`, the `/admin` alert log and `ADMIN_ALERT_EMAIL`); a capped vendor's owner gets a plain notice. `RETENTION_DAYS` defaults to 365. See the Security block in `.env.example`.

## Env vars
See `.env.example`. Key ones: `BUSINESS_NAME`, `VERTICAL` (home_services|braiders), `BUSINESS_VERTICAL` (plumber|hvac), braiders: `SERVICES`, `SLOT_STEP_MINUTES`, `BOOKING_LINK`; `OWNER_PHONE`, `FORWARD_TO_PHONE`, `TWILIO_*`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_BASE_MONTHLY/_ANNUAL`, `STRIPE_PRICE_ID_SETUP`, `TRIAL_DAYS`, `ANNUAL_UPGRADE_PRORATION`, `MONTHLY_DOWNGRADE_PRORATION`, `BILLING_PORTAL_RETURN_URL`, `BILLING_ENFORCE`, `BILLING_REQUIRE_SUBSCRIPTION`, `PAST_DUE_GRACE_DAYS`, `INACTIVE_MODE`, `INACTIVE_MESSAGE`, `MOCK_PRICE_*`, `DATA_DIR`, `LEAD_FEE`, `LEAD_FEE_WAIVED`, `STRIPE_CONNECT_ACCOUNT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`; booking: `BOOKING_ENABLED`, `BUSINESS_TZ`, `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BOOKING_LEAD_MINUTES`, `DEPOSIT_ENABLED`, `DEPOSIT_AMOUNT`, `HOLD_MINUTES`, `STRIPE_WEBHOOK_SECRET`.

## Signup emails (Resend)

`/api/waitlist` and `/setup` submissions send (a) a welcome email to the person, with the link to https://trybuzzcall.com/setup (setup submissions get "we got your setup, we'll review and confirm before going live") and (b) an alert to `ADMIN_ALERT_EMAIL` with the email, business type and time. Code: `src/email.js`.

- Transport: Resend HTTP API (`POST https://api.resend.com/emails`), no SDK. Sends are fire-and-forget with a timeout; a failed or slow send never fails the form.
- Env: `RESEND_API_KEY` (required to send; without it a masked `[email] skipped` line is logged and the signup is still saved), `EMAIL_FROM` (default `BuzzCall <hello@trybuzzcall.com>`), `ADMIN_ALERT_EMAIL` (default `kojo@bytspot.com`). Optional: `EMAIL_TIMEOUT_MS` (8000), `EMAIL_RECIPIENT_WINDOW_HOURS` (24, one welcome per address per window), `ADMIN_ALERT_MAX_PER_HOUR` (30).
- Logs never contain the API key, full addresses or message bodies.
- **Domain verification is required.** Resend only sends from `trybuzzcall.com` after the domain is verified: add the domain in the Resend dashboard (Domains > Add domain), then add the DNS records it shows at Namecheap (Domain List > trybuzzcall.com > Advanced DNS). Typically: an MX record and an SPF TXT record (`v=spf1 include:amazonses.com ~all`) on the `send` subdomain, and a DKIM TXT record at `resend._domainkey` with the key Resend generates; a DMARC TXT record at `_dmarc` (for example `v=DMARC1; p=none;`) is recommended. Copy the exact values from Resend, then click Verify. Until it is verified, sends fail with an HTTP error in the logs (signups are still saved).

## Outcomes log (`src/outcomes.js`)
One record per missed call, keyed by Twilio `CallSid` and stored in the shop's own store (`db.outcomes`), updated as the
call progresses: `missed` -> `consented` / `no_consent` -> `conversed` -> `slot_offered` -> `booked` -> `deposit_paid`, or
`opted_out` (stages only move forward; opted_out wins). Each record has the shop id/slug, time, hour-of-day and weekday
(shop time zone), `phone_verified` (the caller pressed 1 from that caller ID; method `voice_press_1` and time), the caller
phone (operations only), service requested, urgency (keyword rule: emergency, leak, flood, no heat, no hot water, ASAP, ...
plus the trade's own urgent words), callback time, booking/deposit, and when the owner was buzzed
(`owner_buzz_latency_ms`). The owner's own reply is not observable today, so `owner_response_ms` stays empty. Every hook is
failure-safe: a logging error is logged and ignored, never breaking the voice or SMS webhook.
- **Opt-outs:** any opt-out (STOP, plain-language, Twilio 21610) sets `training_excluded=true` on all of that caller's
  records (kept after a later START) and marks the latest one `opted_out`.
- **Admin:** `/admin/outcomes` (counts per stage, recent records with masked phones), `/admin/outcomes.csv` (operations,
  includes phone and email), `/admin/outcomes-training.csv` (de-identified: no phone, email, name or CallSid; the caller is
  an HMAC-SHA256 hash salted with `OUTCOMES_HASH_SALT`, else a random salt persisted in the platform store; phone numbers,
  emails and the caller's name are scrubbed from free text at capture; `training_excluded` rows are left out). All behind
  admin auth.
- **Retention:** `OUTCOMES_MAX_RECORDS` (default 10000) per shop; past the cap the oldest records are pruned on insert.
  Outcomes are not purged by `RETENTION_DAYS`. Note: the shop's whole store is one JSON document, so a large cap makes
  each save bigger; lower the cap if saves get slow.
- **Optional email step:** `OUTCOMES_EMAIL_STEP=1` (default off: production behaviour unchanged). After booking, the caller
  is asked "Want a confirmation by email? Reply with your email or SKIP." A valid address is stored as `email_unverified`
  and a one-tap link `/o/verify/:token` (valid 7 days) sets `email_verified=true`. Without `RESEND_API_KEY` nothing is
  emailed; the address is still stored.

## Vendor sign-in limits

Failed vendor logins/activations are limited per account+IP (`VENDOR_LOGIN_MAX_FAILS`, 10 / 15 min), per account (`VENDOR_ACCOUNT_MAX_FAILS`, 100 / 15 min) and per IP (`VENDOR_IP_MAX_FAILS`, 30 / 10 min). `VENDOR_GLOBAL_MAX_ATTEMPTS` (5000 / 10 min) is only a backstop, so a few IPs cannot lock every vendor out.

## Twilio setup
1. Buy a local GA number (404/470/678/770/706/912/229/478/762).
2. **A2P 10DLC**: register a brand and campaign (required for US SMS deliverability).
3. Number → Voice "A call comes in": `POST {PUBLIC_BASE_URL}/twilio/voice`
4. Number → Messaging "A message comes in": `POST {PUBLIC_BASE_URL}/twilio/sms`
5. Set `FORWARD_TO_PHONE` to the owner's cell. Calls ring there for `RING_TIMEOUT_SECONDS`, and if unanswered the text-back starts. Alternative: keep the shop's existing number and set *conditional call forwarding (no-answer)* on the carrier to the Twilio number, leaving `FORWARD_TO_PHONE` empty.
   Either way the owner gets an instant buzz per missed call ("BUZZ <shop>: Missed call from <number> just now. Pressed 1 - texting them now." / "... Didn't opt in to texts - call them back."); `INSTANT_MISSED_BUZZ=0` turns it off.
6. When Twilio keys are set, webhook signatures are validated against `PUBLIC_BASE_URL`, so it must match the public URL exactly.

## Public tunnel
```bash
ngrok http 3000                                  # or:
cloudflared tunnel --url http://localhost:3000
```
Put the https URL in `PUBLIC_BASE_URL`, restart, and paste the webhook URLs into Twilio.

## Stripe
Pricing: base plan starting at $49/mo, plus a per-paid-lead fee (default $12, `LEAD_FEE`) only when a caller books and pays the deposit; free 14-day trial; setup $99 (estimate), waived for the first 10 founding shops and on annual plans, charged only after the free trial. Deposits for bookings are charged on BuzzCall's platform and transferred to the shop after the appointment (below).

### Stripe Connect: deposit protection (`src/connect.js` + `src/deposits.js`)

- **Charge model: separate charges and transfers.** The customer Checkout Session is created on BuzzCall's **platform** account (no `stripeAccount`, no immediate `transfer_data`). After the appointment (+ `DEPOSIT_RELEASE_HOURS`, default 24), the app Transfers the vendor share to their Express account. **Why not destination charges?** Destination charges transfer immediately (minus an application fee), so they cannot hold funds until after the job. Separate charges + transfers cleanly support delayed payout, refunds before transfer, and transfer reversals after release.
- **Express accounts** for vendors. Vendor portal / admin **Connect payouts** creates or reuses an Express account and an Account Link (`return` / `refresh` URLs). `stripe_account_id` is stored per shop in the config override (`store.getOverride().stripeConnect`). If a shop is not connected, deposits still work and payout stays pending on the platform.
- **Platform fee:** `DEPOSIT_PLATFORM_FEE_PCT` (default 0) is deducted from the Transfer amount. Lead fees remain booking bookkeeping (`due` / `waived` / `review`).
- **No-show check:** `NOSHOW_CHECK_HOURS` (default 12) after the appointment, never between 9pm and 8am shop-local. Texts only customers with SMS consent who have not opted out, at most once per booking. YES logs; NO pauses payout, alerts owner + shop, and replies with the paused-payment message. YES/NO are only treated as no-show answers when a check is pending for that number.
- **Webhooks:** platform `{PUBLIC_BASE_URL}/stripe/webhook` — `checkout.session.completed`, `charge.refunded`, transfer events as needed. Connect `{PUBLIC_BASE_URL}/stripe/connect/webhook` — `account.updated`, `account.application.deauthorized` (secret `STRIPE_CONNECT_WEBHOOK_SECRET`). Signature verification matches the existing pattern.
- **Mock mode** (no `STRIPE_SECRET_KEY`): full flow on `/pay/mock/:id`, mock Connect onboarding, and admin **Demo: advance 24h** (`POST /admin/deposits/demo/advance`, gated to mock + `DEMO_MODE` / non-production).
- **Go-live checklist (Stripe Dashboard):**
  1. Enable Connect; use **test** keys first (`sk_test_…`).
  2. Platform webhook → `{PUBLIC_BASE_URL}/stripe/webhook` with events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `payment_intent.succeeded` (optional), `transfer.created`, `transfer.reversed`.
  3. Connect webhook (Connected accounts) → `{PUBLIC_BASE_URL}/stripe/connect/webhook` with `account.updated`, `account.application.deauthorized`.
  4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`. Do not put live keys in Render until the test pass is done.
  5. Complete Express onboarding from the vendor portal (**Connect payouts**), book + pay with `4242…`, confirm hold → release after advance / wait, try a NO no-show and a refund.


### Shop subscription billing (`src/billing.js`)
Built on the installed `stripe` npm package **16.12.0** (API version `2024-06-20`, where `current_period_end` is on the subscription).
- **Public signup is `/setup` only (2026-10-25).** The public `POST /api/checkout` returns 410 `{next: "/setup"}`; the landing page pricing buttons go to `/setup` or the pilot list. What follows describes the admin-only legacy tool (HTTP Basic admin + same-origin), kept for the single-shop billing flow.
- **Signup (legacy, admin only):** `POST /api/checkout {plan: "monthly"|"annual", email?}` creates a Checkout Session with `mode: "subscription"`, `payment_method_collection: "always"` (card required), and `subscription_data.trial_period_days = TRIAL_DAYS` (default 14). It also sets `trial_settings.end_behavior.missing_payment_method = "cancel"`. There's no `billing_cycle_anchor`, so the cycle anchors on signup and the first paid period starts when the trial ends (no partial first month).
- **Setup fee** (`STRIPE_PRICE_ID_SETUP`, ~$99 estimate): *Setup $99, waived for our first 10 founding shops and on annual plans; charged only after your free trial.*
  - Waived when: (1) the plan is annual; (2) there's an override (`SETUP_FEE_WAIVED=1`, a signup with `setup_waiver_code` = `SETUP_WAIVER_CODE`, or `setup_waived=1` on an admin-authenticated `/api/checkout`); (3) the shop is one of the first `FOUNDING_SHOPS_LIMIT` (default 10) shops in `db.billing.shops`. A shop that cancels during its trial without ever paying frees its founding slot.
  - Otherwise, on `checkout.session.completed` we call `stripe.invoiceItems.create({customer, price: STRIPE_PRICE_ID_SETUP, subscription})` with an idempotency key. A pending invoice item with `subscription` set is pulled into that subscription's **next** invoice, which is the first one after the trial, so nothing is charged at signup. Checkout shows a `custom_text.submit` note about this.
  - If the subscription is deleted during the trial (cancelled, or no card at trial end), or the shop switches to annual during the trial, the pending item is deleted (`invoiceItems.del`) and no setup fee is charged. `invoice.paid` marks it `paid` when its line appears on the invoice.
  - With `TRIAL_DAYS=0` the setup price is a Checkout line item instead, since the first invoice is at signup.
  - Status per shop (waived/pending/paid/voided) shows in `/admin` → Shops and in `/billing/status`.
- **Plan change** (admin auth): `POST /api/billing/preview {plan}` uses `invoices.createPreview` with `subscription_details` and `proration_date`. `POST /api/billing/change-plan {plan, proration_date?}` uses `subscriptions.update` to swap the item price with `proration_behavior` `always_invoice` (monthly→annual, `ANNUAL_UPGRADE_PRORATION`) or `create_prorations` (annual→monthly, `MONTHLY_DOWNGRADE_PRORATION`). Changing the interval restarts the cycle on the change date. Pass the preview's `proration_date` to charge exactly what was previewed.
- **Cancel / resume** (admin): `POST /api/billing/cancel` sets `cancel_at_period_end: true`. Access continues to `current_period_end` and there are no partial refunds. `POST /api/billing/resume` undoes it.
- **Self-service:** `GET /billing/portal` (admin) redirects to a Stripe Billing Portal session (`return_url` = `BILLING_PORTAL_RETURN_URL` or `{PUBLIC_BASE_URL}/`).
- **Webhooks** (`/stripe/webhook`, verified with `STRIPE_WEBHOOK_SECRET`): `checkout.session.completed` (subscription mode), `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, and `customer.subscription.trial_will_end`. Events are de-duplicated by id. In live mode the subscription is **re-fetched from Stripe** on each event, so out-of-order events can't store a stale status. The store keeps `db.billing.subscription` = status, plan, price, amount, `current_period_end`, `trial_end`, `cancel_at_period_end`, and `past_due_since`, plus invoices.
  - The owner gets a text on `invoice.payment_failed` (with the portal link) and on `trial_will_end` (Stripe sends it 3 days before the trial ends).
- **Service gating** (`billing.access()`): `trialing`/`active` means full service. `past_due` (after `PAST_DUE_GRACE_DAYS`), `canceled`, `unpaid`, `incomplete*` and `paused` mean inactive.
  - When inactive, a missed call or text gets one polite generic text per number per 24h (`INACTIVE_MODE=generic`, or `INACTIVE_MESSAGE`), with no conversation, booking, or deposit. `silent` sends nothing.
  - Deposits already in progress still complete.
  - With no subscription on file, service stays active unless `BILLING_REQUIRE_SUBSCRIPTION=1`, so manual pilots keep working. `BILLING_ENFORCE=0` turns gating off.
- **Status:** `/admin` shows a Subscription section at the top. `GET /billing/status` (admin) returns JSON, and `/health` shows `billing` and `serviceActive`.
- **Mock mode** (no `STRIPE_SECRET_KEY`): `/api/checkout` returns `/billing/mock/checkout/:id`. Its form posts to `/billing/mock/checkout/:id/complete`, which starts the trial, charges the mock setup fee on monthly, and fires the same events through the same handler.
  - Admin-only controls: `POST /billing/mock/advance {days}` moves a mock clock and fires `trial_will_end`, renewals, and period-end cancellation. `POST /billing/mock/fail-next {on}` makes the next renewal fail. `POST /billing/mock/update-card` pays the open invoice. `GET /billing/mock/portal` is the mock portal.
  - Mock proration credits unused time on the old plan and charges the new plan for a full new period; any negative remainder becomes account credit. Amounts come from `MOCK_PRICE_*`.
  - Demo: `bash scripts/demo_billing.sh` starts its own server on `:3077` with a throwaway `DATA_DIR`, so `data/` and `:3000` are untouched. It shows founding shop #1 (no setup fee), shop #11 monthly ($49 + $99 on the first post-trial invoice), shop #12 cancelling in its trial (setup voided, $0), and shop #13 annual (waived). Then it runs the full lifecycle on shop #11 (`/billing/mock/primary` picks which mock shop drives gating; the billing APIs accept an optional `sub`).
- **Stripe dashboard setup (live):**
  1. Create a Product with a monthly and a yearly recurring Price, plus an optional one-time setup Price, and put their ids in the env.
  2. Turn on the Customer Portal (Settings → Billing → Customer portal): allow payment-method updates, invoice history, and cancel *at end of billing period*. If you want switching in the portal, add both Prices to its plan-switching list.
  3. Add a webhook endpoint for the events above.
  4. Under Billing → Subscriptions and emails, pick the retry schedule and what happens after all retries fail (cancel or mark unpaid). Both count as inactive here.
  5. Optionally enable the trial-ending reminder email.

## Limits / next steps
Multiple isolated vendor stores run in one application process. **Run only one application instance/worker:** the existing JSON-document storage keeps an in-memory cache and is not safe for concurrent writers across instances. No automatic legacy-to-vendor migration, email delivery for invitations, or outbound SMS retry queue is included. Vendor onboarding does not establish SMS permission or carrier approval; complete the existing consent and provider checks before live use.

## Persistence (restart-proof setups and config)

Platform and legacy state lives in files under `DATA_DIR` (`db.json`, `config.json`). Vendors use private `shops/<id>/` directories and distinct `shop:<id>:db` / `shop:<id>:config` Postgres keys; they never load legacy data as their own. Vendor database connections share a bounded pool. Graceful shutdown drains requests and flushes both platform and vendor stores before exiting. On hosts with an ephemeral filesystem (Render free plan) those are wiped on every restart/redeploy/spin-down. Set `DATABASE_URL` to a Postgres connection string and the same two JSON documents are stored in a `buzz_kv` table instead (created automatically; the first boot seeds it from any existing files). Writes are debounced (~200 ms) and flushed on SIGTERM. Opt-outs and opt-ins skip the debounce and are written immediately. If `DATABASE_URL` is set but Postgres is unreachable at boot, the app falls back to file storage so the line keeps answering; in production it logs a loud warning and sends an owner alert. In production with `DATABASE_URL` set this is fatal instead, with no flag needed (retries `REQUIRE_POSTGRES_RETRIES`, default 5, 3 s apart, then exits so Render keeps the previous deploy or restarts); `REQUIRE_POSTGRES=1` extends that to a missing `DATABASE_URL`. If writes fail after boot, opt-outs are also appended to `DATA_DIR/optout-spill.jsonl` (merged at the next boot), `/health` shows `storageState: "degraded"`, and the owner is alerted once per outage. Admins see the full storage state on `/health` (with credentials) and at the top of `/admin`. Public `/health` shows only `storageState: "ok"|"degraded"`; the backend (`storage: "file"|"postgres"`) and `storageDetail` are in the admin view only (send Basic auth). Opt-ins (START) are not written to the spill file and opt-in lines are ignored when it is merged, so the file can only add opt-outs: an opt-in during an outage still applies in memory and reaches Postgres on recovery, but if the server restarts mid-outage the caller must text START again (the safe direction). `DATA_DIR` and `SPILL_DIR` must be absolute paths in production and may not point inside the app folder (except the default `data/`) or `public/`; a refused value is ignored with a loud warning (shown on admin `/health` and `/admin`) and the safe default is used (`<app>/data`, or `DATA_DIR` for the spill file). Folders are created `0700` and files `0600`, and a group- or world-writable folder is flagged. Note `sms.log` is a log only and stays file-based. Tests: `tests/storage.test.js` (set `TEST_DATABASE_URL` to also exercise a real database).

## Hosting for the pilot: not on Render Free or Neon Free

Don't run a live pilot on free tiers. Checked 2026-10-25 against https://render.com/docs/free, https://render.com/pricing and https://neon.com/pricing:

- **Render Free web service:** spins down after 15 minutes without traffic and takes about a minute to spin back up (a missed call that arrives while it is waking up may get no text-back); local files, including the opt-out spill file, are lost on every spin-down, restart and redeploy; no persistent disks; Render "might restart a Free web service at any time"; 750 free instance hours per workspace per month, after which Free services are suspended. Render's own docs say not to use Free instances for production.
- **Render Free Postgres:** expires 30 days after creation (deleted after a 14-day grace period), 1 GB, no backups, maintenance/restarts at any time.
- **Neon Free:** compute always scales to zero after 5 minutes idle (cold start on the next query), 100 CU-hours per project per month (compute is suspended until the next billing period when used up), 1 GB storage per project, 6-hour history window, community support only.

**Estimated** monthly cost of a minimal paid setup (list prices on the pages above, 2026-10-25; estimates, not quotes; excludes Twilio and Stripe fees):

| Piece | Option | Estimate |
|---|---|---|
| Web service | Render "Less than 1 CPU" (0.5 CPU / 512 MB, plan `0.5c-512mb`) | ~$7/month |
| Persistent disk for `SPILL_DIR` (optional) | Render SSD, 1 GB at $0.25/GB-month | ~$0.25/month |
| Database | Render Postgres basic (`0.1c-256mb`, 1 GB included) | ~$6/month |
| or | Neon Launch, 0.25 CU at $0.106/CU-hour: ~$19/month if always on (0.25 × 730 h × $0.106), much less with scale-to-zero; storage $0.35/GB-month (this app stores well under 1 GB) | ~$2–20/month |
| Workspace | Render Hobby | $0 |

So roughly **$13–27/month** (estimate). Note: per Render's docs a persistent disk **disables zero-downtime deploys**, so with a disk a failed boot (fail-closed storage) means downtime instead of Render keeping the previous deploy live. Use `SPILL_DIR` with a disk only if you accept that; otherwise leave it unset (the spill file then only survives a process restart on the same instance, and the owner alert lists the masked opted-out numbers as the out-of-band record).

## Go-live checklist (pilot)

- Hosting: a paid Render instance and a paid database (see above), not Free.
- Render env: `NODE_ENV=production`, `DATABASE_URL` (the app refuses to start without Postgres when it is set), a 20+ character `ADMIN_PASSWORD` (plus `ADMIN_USERNAME`, `ADMIN_PASSWORD_STRICT=1`), `OWNER_PHONE`, `PUBLIC_BASE_URL`. Remove `DEMO_MODE` once Stripe/Twilio are live.
- Twilio console: Geo-Permissions US/Canada only, SMS Pumping Protection on. Keyword replies: by default the app sends shop-named HELP, STOP and START replies (`KEYWORD_REPLIES=app`). With Twilio Advanced Opt-Out's own auto-replies on, Twilio's STOP reply is the one delivered (it blocks the app's) and START gets both replies, so either turn Twilio's keyword auto-replies off or set `KEYWORD_REPLIES=twilio` to leave exact STOP/START confirmations to Twilio.
- **Voice consent (A2P 10DLC):** a missed call never texts on its own. The caller hears "[Shop] can't take your call right now. Press 1 and we'll text you at this number to get you booked. Message frequency varies, message and data rates may apply. Reply STOP to opt out or HELP for help." and only a 1 starts the text-back. Every answer is logged per shop (`db.voiceConsents`: time, CallSid, From, shop id, digits, script). Per-shop wording: `VOICE_CONSENT_PROMPT` (keep `{shop}`, "Press 1", the frequency/rates disclosures, STOP and HELP, or the default is used); `VOICE_CONSENT_SPANISH=1` adds the Spanish script. No caller text is ever sent without a shop name (`BUSINESS_NAME`); blocked sends alert the platform admin.
- **Public SMS page per shop:** `/s/<slug>/sms` (slug = shop name lowercased, words joined by `-`; a second shop with the same name gets `-<first 6 of its id>`). Use it as the A2P campaign's opt-in proof URL.
- **Area codes:** text-backs go only to US/Canada area codes in `src/areaCodes.js` (NANPA list, refreshed yearly; a test fails when it is ~12 months old). If the shop serves callers from a code that is skipped (a brand-new overlay, or Puerto Rico 787/939, USVI 340, Guam 671), set `TEXT_EXTRA_AREA_CODES=787,939`. The owner gets a daily text counting callers skipped for their area code.
- Check admin `/health` (with Basic auth) shows `storage: "postgres"`, `storageState: "ok"`, and the boot log shows `[store] postgres backend ready` and `fail-closed ON`.
- Review caps and retention: `OUTBOUND_SHOP_MAX_PER_HOUR` (100), `OUTBOUND_SHOP_MAX_PER_DAY` (300), `OUTBOUND_MAX_PER_HOUR` (200), `OUTBOUND_MAX_PER_DAY` (500), `RETENTION_DAYS` (365), `BOT_PAUSE_HOURS` (72).
