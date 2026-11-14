# BuzzCall (TryBuzzCall) — MVP

When a customer call is missed, BuzzCall can text the caller back, collect **name / need / callback window**, then **buzz the owner by SMS** with who/what and a tap-to-call link. Built for any appointment-based local business that books by phone, in any US state; home services (plumbing/HVAC, **Home Services**) and hair braiders (**Braiders**) are the featured pilots. **A missed call is not SMS consent. SMS_ENABLED defaults off.** Automatic text-back is available only for a recipient with a recorded, active `customer_service` grant for that business and sender. Owner texts separately require an `owner_alerts` grant. It does not do spam filtering.

## Platform and vendor workspaces

- `/admin`: platform administration using the existing admin credentials. Review and approve onboarding, create individual vendor accounts, assign phone lines, revoke access, and monitor vendor billing/payout status.
- `/vendor/login`: each shop owner's separate sign-in. `/vendor` shows only that shop's calls, leads, bookings, subscription and payouts; `/vendor/settings` edits its business settings.
- `/admin/legacy`: the original single-business workspace and records, still restricted to platform administrators. Existing customer, phone, payment and consent records are not silently assigned to a vendor.

See [Vendor workspaces](docs/VENDOR_WORKSPACES.md) for enrollment, routing, isolation and operating limits. Live card entry and payout onboarding remain on Stripe-hosted pages.

See [Admin workspace and payment pages](docs/ADMIN_WORKSPACE.md) for behavior and validation notes. Opening `/pay/mock/:id` no longer completes a simulated payment; an explicit same-origin POST is required. The payment return pages do not treat query strings as proof of payment. This redesign does not deploy the app or enable live payments/SMS.

## SMS permission and launch boundary
This branch documents a conservative recorded-permission implementation, **not a compliance certification or carrier approval**. Verify the implementation and deployed version against [SMS Operations](docs/SMS_OPERATIONS.md) and the [Pilot Checklist](docs/PILOT_CHECKLIST.md) before enabling live SMS. The public [consent page](public/sms-consent.html), [SMS Terms](public/terms.html#sms), and [Privacy Policy](public/privacy.html) remain legal drafts pending counsel review.

- Obtain and retain actual written opt-in evidence outside the application in secured storage, collected outside SMS. An authenticated platform admin records the recipient, purpose, consent timestamp, disclosure version, and a non-secret evidence reference; the reference alone is not proof of consent.
- Grants are scoped to business id + sender + phone + purpose. The legacy single-business line uses the stable `SMS_CONSENT_BUSINESS_ID` slug and the configured E.164 `TWILIO_PHONE_NUMBER`; a vendor shop uses its shop id and its assigned shop number. Purpose is either `customer_service` or `owner_alerts` (owner/staff/platform alerts, billing/account notices, and SMS sign-in/OTP codes). Do not transfer consent between businesses or senders. Review changed identities before collecting new permission.
- **No automatic grants** from missed calls, inbound messages, START, payments, waitlist signup, or merely providing a number. Press-1, setup, onboarding and signup forms do not create grants either. Do not send an unsolicited SMS to request initial opt-in. Twilio permits a limited response to an inbound message within its scope; this application deliberately requires recorded written permission even for that exchange and does not infer recurring consent.
- Every application SMS uses the central permission gate, including booking/deposit confirmations, owner alerts, billing reminders, sign-in/OTP codes, HELP replies, and inactive-service messages. The feature descriptions below are conditional on that gate; a booking or payment does not guarantee a text. Owners without an `owner_alerts` grant receive no alerts or OTP codes. Provider-generated opt-out/help replies are separate.
- STOP keywords and natural-language requests revoke **all purposes** locally. START only clears a delivery block; it never restores grants. UNSTOP and YES have the same limited behavior. After opt-out, obtain fresh evidence and record a fresh grant. If Twilio has blocked delivery, the recipient must explicitly opt back in with the provider first; operators must not bypass that block.
- Calls: there is no press-1 offer. A missed caller with written permission on file (and SMS enabled) gets an automatic text-back; anyone else hears a polite message to call again later and is not texted. Voice never claims that a text was sent when none was. Customers may use the business's phone service without agreeing to SMS; consent is not a condition of purchase.
- Messages are nonmarketing. Message frequency varies; message and data rates may apply. Reply STOP to opt out or HELP for help. Carriers are not liable for delayed or undelivered messages. Mobile opt-in data is not shared with or sold to third parties for marketing.

### Official sources versus application safeguards
The following official sources describe provider requirements, not approval of BuzzCall or any particular customer. Legal, customer-identity, campaign, sender, and evidence review remain external launch prerequisites.

- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) (April 13, 2026 version): prior express consent and proof; written consent for downstream software customers; inbound SMS permits a scoped exchange, not general recurring messages; consent cannot be transferred.
- [A2P 10DLC ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv): register the actual customer identities, not every shop under a blanket platform brand.
- [A2P 10DLC quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart): verify the campaign and associate its sending number; do not solicit initial opt-in by unsolicited SMS.
- [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out): standard keyword filtering is distinct from Advanced Opt-Out, which is disabled by default. When Twilio sends `OptOutType` START, STOP, or HELP, the provider has already replied; the application must not duplicate that reply.

## Stack
Node 20 + Express. Leads, bookings, and consent records live in each shop's JSON store: Postgres (`DATABASE_URL`) in production, or files under `DATA_DIR` (default `data/db.json`) for local/file use, with no native dependencies. Uses the Twilio SDK, optional OpenAI (via fetch), and the Stripe SDK. Production requires Postgres via `DATABASE_URL`; Render free/ephemeral disk is not durable, and a `DATA_DIR` on a Render persistent disk is not a substitute. A grant is visible only after a successful durable write. Protect the database, data directory and logs, and verify grants and revocations survive a restart.

```
Caller ──call──▶ Twilio number ──POST /twilio/voice──▶ <Dial FORWARD_TO_PHONE>
                                   │ no-answer/busy ──▶ POST /twilio/voice/status
                                   ▼
                       central gate: customer_service grant for business + sender + caller?
                                   │ yes (and SMS_ENABLED=1) ──▶ text-back SMS to caller (agent.firstMessage)
                                   └ no ──▶ <Say> "please call again later" (no text)
Caller ──SMS──▶ POST /twilio/sms ──▶ agent.handleReply (name → need → window), permissioned recipients only
                                   └─ when complete ──▶ BUZZ SMS to OWNER_PHONE (owner_alerts grant required)
```

1. Twilio sends a validated call webhook to `/twilio/voice` and forwards the call when configured.
2. On a missed call, `/twilio/voice/status` may start text-back **only after the central gate permits `customer_service`**. Otherwise there is no automatic SMS, and the caller hears a polite message to call again later.
3. Validated inbound SMS reaches `/twilio/sms`; incoming content does not itself grant permission. Permitted conversations collect name, need, and callback window or booking choice.
4. Owner notifications separately pass the gate for `owner_alerts`; being the owner or setting `OWNER_PHONE` does not grant permission.

### Conversation loop and wrap-up

The loop below applies only to recipients with an active written `customer_service` grant.

- Calls: there is no press-1 offer. A permissioned missed caller gets the text-back; anyone else hears a call-again-later message and is not texted. Text-backs are limited per caller by `TEXTBACK_COOLDOWN_MINUTES`.
- SMS: retain a supplied job or explicitly named service while clarifying a missing name once. `skip` continues unnamed; never use a greeting or service as the name. Numbered services are accepted only after intake reaches the service step.
- Recover once from unclear service/day/time choices, then offer a callback. `callback`/`human` works from any active step; repeated requests at the callback-window step finish without inventing a time.
- Callback wrap-up includes the shop, request and preferred window, and says this is not a confirmed appointment. Booking holds, payments and confirmations retain their existing separate paths.
- Repeat calls resume the active question. Short acknowledgements within 24 hours of completion stay in that thread without another owner completion buzz; `new request` opens a fresh intake.
- State-critical messages are deterministic, so a model cannot replace a retained name or change the question. The reusable phrasing prompt is documented in [Conversation flow and prompt](docs/CONVERSATION_FLOW.md).
- Offline harness: `node --test tests/conversation-flow.test.js tests/a2p-compliance.test.js tests/voice.test.js tests/trades.test.js`. It uses isolated temporary storage and log-only providers; no real calls, SMS or payments.

### Optional booking + deposit
All texts in this flow require the recipient's active grant and pass the central gate, including messages triggered by a later payment. With `BOOKING_ENABLED=1`, after the *need* step a permissioned caller can receive the 3 next open slots (from `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BUSINESS_TZ`) and replies `1`/`2`/`3`, or `callback` to fall back to the classic callback-window flow.
- **No deposit** (`DEPOSIT_ENABLED` off): the slot is booked at once, the caller gets a confirmation, and the owner gets `BOOKED (no deposit)`.
- **Deposit** (`DEPOSIT_ENABLED=1`, `DEPOSIT_AMOUNT` default 49): the slot is *held* for `HOLD_MINUTES` and the caller gets a pay link. The owner gets `slot held, deposit pending`.
  - With `STRIPE_SECRET_KEY`, the link is a Stripe Checkout Session (mode `payment`, `metadata.bookingId`) created on the **shop's connected account** (`Stripe-Account`). It is refused until that account has charges enabled, no `disabled_reason`, and an admin approval. Payment events arrive on the connected-account webhook `{PUBLIC_BASE_URL}/stripe/connect/webhook`, verified with `STRIPE_CONNECT_WEBHOOK_SECRET`. Only a verified paid event confirms the deposit. Local simulations use the explicit mock routes, not unsigned webhooks.
  - **No connected account, no live deposit.** Mock mode (no Stripe key) still uses `/pay/mock/:id`.
  - Without a key, the link is `{PUBLIC_BASE_URL}/pay/mock/:id`. Opening it is read-only; an explicit same-origin POST completes the simulation.
  - On payment the booking becomes `confirmed`. A caller with an active `customer_service` grant gets a confirmation text, and an owner with an active `owner_alerts` grant gets `BOOKED + PAID $49: name, need, slot, lead fee $12, tel:…`. Payment never grants SMS permission.
- **Per-paid-lead fee** (`LEAD_FEE`, default 12 USD): only when a caller books *and* pays the deposit. Recorded on the booking as `lead_fee` + `lead_fee_status` when it is marked paid:
  - `LEAD_FEE_WAIVED` **defaults ON** (pilot; only an explicit `0`/`false`/`off` disables it): no application fee; status `waived`, fee $0.
  - If enabled: recorded as `due` on the booking (may be invoiced or netted from payouts), capped at deposit − 1¢ **and** at ⌊deposit/3⌋ for bookkeeping.
  - Mock flow without Stripe keys and no mock connected account: status `due`. A payment that arrives after its slot was lost (`paid_conflict`) gets status `review`.
  - `/admin` shows the lead-fee total (due / collected / waived / review) and the fee on each booking.
- **Refunds:** the shop refunds a deposit in its own Stripe Dashboard. Admin Refund / Release on a direct-model row does not move money. No-show YES/NO is a reputation flag. A reply is NO only when it is exactly `NO` or `NOSHOW` (`No problem` is not a no-show).
- Files: `src/booking.js` (slots, holds, Stripe/mock links, direct-charge params, fail-closed skip, lead fees, mark-paid), `src/connect.js` (connected account state, onboarding, status, fee cap).
- Bookings live in `data/db.json` → `bookings`. A slot that is `held` (and not expired) or `confirmed` is never offered or booked again, and the hold is re-checked at pick time. Expired holds release the slot. A payment that arrives after expiry, when someone else has taken the slot, is flagged `paid_conflict` and the owner is told to reschedule or refund.
Files: `src/server.js` (routes), `src/billing.js` (shop subscription billing), `src/agent.js` (deterministic trade-aware intake and wrap-up; an optional OpenAI phrasing helper remains available but is not called for intake turns), `src/sms.js` (Twilio or log-only), `src/store.js`, `public/index.html` (landing page and waitlist).

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
  - Preferred day understands `today`, `tomorrow`, weekday names, `10/24`, `Oct 24`. Explicit `soonest`/`any` requests mean the earliest opening. Unknown or invalid days get a clarification, then a callback alternative rather than silently choosing a date. If that day is full, the caller gets the closest openings after it.
  - `BOOKING_LINK` (optional): the stylist's own Booksy/StyleSeat/GlossGenius link, added to the time-offer and callback texts.
  - Owner texts: `BUZZ …: time held, deposit pending …`, then `BOOKED + PAID: <name>, <service>, <time>, $50 deposit. Notes: <size/length>. tel:…`.
  - Legacy demo: `bash scripts/demo_braiders.sh` attempts a booking + mock deposit and callback using a temporary server if needed. It has not been established as compatible with the new webhook and consent requirements; do not expect SMS or the old transcript without manual permission setup or a later script update. Only run one server against a data directory at a time.

## Run locally (SMS off by default)
```bash
cp .env.example .env
npm install
npm start                      # http://localhost:3000
bash scripts/demo_simulate.sh  # in a second terminal: booking + mock deposit, then the classic callback path
bash scripts/demo_billing.sh   # shop subscription lifecycle (mock Stripe; own temp server on :3077)
bash scripts/demo_braiders.sh  # braider flow (stop the server above first, or it will refuse if that server isn't VERTICAL=braiders)
```
SMS output (only for permitted sends) goes to `data/sms.log` (bodies locally; metadata only in production) and a one-line, body-free summary to the console. Admin page: http://localhost:3000/admin (Basic authentication: any username unless `ADMIN_USERNAME` is set, password `ADMIN_PASSWORD`; repeated wrong passwords lock the client out for 15 min; keep credentials out of URLs, examples, and logs).

Unsigned **local-only** Twilio simulations require `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1`, no live credentials, and `NODE_ENV` other than `production`. This exception never authorizes an unsigned live Twilio request. `SKIP_TWILIO_VALIDATION` no longer bypasses live validation. Do not expose an unsigned-demo server through a public tunnel.

Legacy scripts `scripts/demo_simulate.sh`, `scripts/demo_billing.sh`, and `scripts/demo_braiders.sh` may need manual consent setup or later updates. They no longer text by default, and their previous booking/SMS transcripts are not guaranteed. To exercise SMS locally, use isolated test data, an explicit local configuration, and the authenticated consent workflow in [SMS Operations](docs/SMS_OPERATIONS.md). Log-only SMS still passes the permission gate. Protect `DATA_DIR` and its SMS logs; do not treat a log entry as live delivery or carrier approval.

**Production vs demo:** Render sets `NODE_ENV=production`. There, mock/demo behaviour (Twilio webhooks without `TWILIO_AUTH_TOKEN`, `/pay/mock/*`, `/billing/mock/*`, mock checkout) is refused unless `DEMO_MODE=1`; `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1` is never honoured there. `/stripe/webhook` requires `STRIPE_WEBHOOK_SECRET` (503 without it) and a valid signature. Every POST to `/admin/*`, `/api/billing/*`, `/api/consent` and `/billing/*` (mock billing included) needs a same-host `Origin` (or `Referer`) header, enforced by one central guard; browsers send it, scripts must add `-H "Origin: $BASE"`. Applying a setup that changes `OWNER_PHONE`/`FORWARD_TO_PHONE` asks for a second confirmation (`confirm_phones=1`). Opt-outs (STOP and friends, or natural-language requests such as "stop texting me") revoke all purposes and are honoured before every send; an exact Twilio keyword is confirmed by Twilio. Text-backs go only to US/Canada area codes (`TEXT_EXTRA_AREA_CODES` adds more), capped per line by `OUTBOUND_SHOP_MAX_PER_HOUR` (100) and `OUTBOUND_SHOP_MAX_PER_DAY` (300) (a vendor's own limit can be set in `/admin`; 0 = off) and across all lines by `OUTBOUND_MAX_PER_HOUR` (200) and `OUTBOUND_MAX_PER_DAY` (500). Cap alerts go to the platform admin (platform `OWNER_PHONE` with an `owner_alerts` grant, the `/admin` alert log and `ADMIN_ALERT_EMAIL`); a capped vendor's owner gets a plain notice when permitted. `RETENTION_DAYS` defaults to 365. `/health` includes `smsEnabled`. See the Security block in `.env.example`.

## Env vars
See `.env.example`. For SMS, explicitly configure `SMS_ENABLED` (default off), `SMS_CONSENT_BUSINESS_ID` (stable slug for the legacy single-business line; vendor shops use their shop id), and `TWILIO_PHONE_NUMBER` (E.164 legacy sender; a vendor shop sends from its assigned number); neither display names nor request-supplied identities replace these. Keep SMS disabled until the reviewed launch checks pass. Other key ones: `BUSINESS_NAME`, `VERTICAL` (home_services|braiders), `BUSINESS_VERTICAL` (plumber|hvac), braiders: `SERVICES`, `SLOT_STEP_MINUTES`, `BOOKING_LINK`; `OWNER_PHONE`, `FORWARD_TO_PHONE`, `TWILIO_*`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_BASE_MONTHLY/_ANNUAL`, `STRIPE_PRICE_ID_SETUP`, `TRIAL_DAYS`, `ANNUAL_UPGRADE_PRORATION`, `MONTHLY_DOWNGRADE_PRORATION`, `BILLING_PORTAL_RETURN_URL`, `BILLING_ENFORCE`, `BILLING_REQUIRE_SUBSCRIPTION`, `PAST_DUE_GRACE_DAYS`, `INACTIVE_MODE`, `INACTIVE_MESSAGE`, `MOCK_PRICE_*`, `DATA_DIR`, `DATABASE_URL`, `LEAD_FEE`, `LEAD_FEE_WAIVED`, `STRIPE_CONNECT_ACCOUNT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`; booking: `BOOKING_ENABLED`, `BUSINESS_TZ`, `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BOOKING_LEAD_MINUTES`, `DEPOSIT_ENABLED`, `DEPOSIT_AMOUNT`, `HOLD_MINUTES`, `STRIPE_WEBHOOK_SECRET`.

## Signup emails (Resend)

`/api/waitlist` and `/setup` submissions send (a) a welcome email to the person, with the link to https://trybuzzcall.com/setup (setup submissions get "we got your setup, we'll review and confirm before going live") and (b) an alert to `ADMIN_ALERT_EMAIL` with the email, business type and time. Code: `src/email.js`.

- Transport: Resend HTTP API (`POST https://api.resend.com/emails`), no SDK. Sends are fire-and-forget with a timeout; a failed or slow send never fails the form.
- Env: `RESEND_API_KEY` (required to send; without it a masked `[email] skipped` line is logged and the signup is still saved), `EMAIL_FROM` (default `BuzzCall <hello@trybuzzcall.com>`), `ADMIN_ALERT_EMAIL` (default `kojo@bytspot.com`). Optional: `EMAIL_TIMEOUT_MS` (8000), `EMAIL_RECIPIENT_WINDOW_HOURS` (24, one welcome per address per window), `ADMIN_ALERT_MAX_PER_HOUR` (30).
- Logs never contain the API key, full addresses or message bodies.
- **Domain verification is required.** Resend only sends from `trybuzzcall.com` after the domain is verified: add the domain in the Resend dashboard (Domains > Add domain), then add the DNS records it shows at Namecheap (Domain List > trybuzzcall.com > Advanced DNS). Typically: an MX record and an SPF TXT record (`v=spf1 include:amazonses.com ~all`) on the `send` subdomain, and a DKIM TXT record at `resend._domainkey` with the key Resend generates; a DMARC TXT record at `_dmarc` (for example `v=DMARC1; p=none;`) is recommended. Copy the exact values from Resend, then click Verify. Until it is verified, sends fail with an HTTP error in the logs (signups are still saved).

## Outcomes log (`src/outcomes.js`)
One record per missed call, keyed by Twilio `CallSid` and stored in the shop's own store (`db.outcomes`), updated as the
call progresses: `missed` -> `consented` / `no_consent` -> `conversed` -> `slot_offered` -> `booked` -> `deposit_paid`, or
`opted_out` (stages only move forward; opted_out wins). `consented` / `no_consent` only record whether a written
`customer_service` grant was already on file for the text-back; an outcome record never creates or restores permission.
Each record has the shop id/slug, time, hour-of-day and weekday (shop time zone), `phone_verified` (no longer set by
voice: the press-1 prompt is removed, so older `voice_press_1` values are historical only), the caller
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

## Self-serve onboarding

With the flags below left unset, `/setup` still only saves a pending request and an admin still creates the vendor. Turn them on in the order in [docs/GO_LIVE_ONBOARDING.md](docs/GO_LIVE_ONBOARDING.md). Nothing that spends money runs unless its flag is on.

| Flag | Default | What it does |
| --- | --- | --- |
| `AUTO_ONBOARDING` | off | After a valid `/setup`, text a 6-digit code to the alert cell (hashed, 10 minutes, 5 tries, rate-limited per phone and IP, US/Canada only). The code is an `owner_alerts` SMS: it is sent only when that cell already has a recorded written `owner_alerts` grant and SMS is enabled. Submitting `/setup` does not create that grant. A correct code creates the vendor with the same `vendors.create` path an admin uses, then the owner sets a password and lands on a checklist. |
| `AUTO_PROVISION_NUMBERS` | off | After the 14-day trial starts, buy one US local number: same area code, then the same state, then any US local. Voice and SMS webhooks point at `/twilio/voice` and `/twilio/sms`. Off, or over the daily cap, or under the Twilio balance floor: the step stays queued or "pending admin" and nothing is bought. |
| `AUTO_A2P` | off | Collect legal name, business type, EIN when required, address, website, and a contact, then submit a Low-Volume Standard brand or a Sole Proprietor brand plus one campaign. A poller stores pending, in review, approved, or rejected. |

`AUTO_PROVISION_MAX_PER_DAY` defaults to 25 (rolling 24 hours). `AUTO_PROVISION_MIN_BALANCE` defaults to $20. The carrier step asks for the legal structure. LLC, corporation, and partnership are sent as Twilio `business_type` `Limited Liability Corporation`, `Corporation`, or `Partnership`, with `company_type` `private`. Nonprofit is `Non-profit Corporation` and `company_type` `non-profit`. Sole proprietor, which does not use those fields, uses the Sole Proprietor registration. Any other type requires a 9-digit EIN. A saved registration with no business type is flagged "needs business type" and is not submitted. The EIN is stored only until the brand submission returns, then only the last four digits remain, and it is never written to logs or HTML. A welcome email goes out only when `RESEND_API_KEY` is set. One verified cell can open one shop unless an admin allows another. The honeypot, consent checkbox, and `/setup` rate limit stay in place.

Self-serve shops do not send customer text-backs until carrier registration is approved, and then only to callers with a written `customer_service` grant. Missed-call buzzes to an owner with an `owner_alerts` grant are not held. Application HELP replies still pass the permission gate; STOP is always honoured. Admin-created vendors are unchanged.

`/admin/onboarding` lists each new shop (verified, trial, number, registration) and flags duplicates, name mismatches, provisioning failures, rejections, a low balance, and a cap hit. Retry, assign a number yourself, record a manual registration result, allow a second shop on a cell, or suspend.

Rough carrier cost once `AUTO_A2P` and number purchase are on: about $4 to register the brand, $15 to vet the campaign, and $1.50 per month for a low-volume campaign (about $21 the first month), plus about $1.15 per month for the local number. Those are Twilio's published list prices and can change. See the go-live note for the doc links.

## Twilio setup (operator review required; no approval implied)
1. Keep `SMS_ENABLED` off while reviewing the actual customer's identity and opt-in process. Any number purchase, carrier submission, fee, or deployment needs separate authorization; this document performs none of them. A local number (for example a GA number: 404/470/678/770/706/912/229/478/762) is bought only with that authorization.
2. For US A2P 10DLC, use the actual business's customer profile and brand, not a blanket TryBuzzCall platform brand. Verify external brand/campaign approval and associate the approved E.164 sender with that campaign/Messaging Service. Registration alone is not consent or guaranteed delivery. The campaign message flow and opt-in proof must describe written opt-in collected outside SMS (the per-shop page `/s/<slug>/sms`). An already published campaign or opt-in proof that describes press-1 must be updated with the carrier before SMS is enabled; this branch does not do that.
3. Number → Voice "A call comes in": `POST {PUBLIC_BASE_URL}/twilio/voice`.
4. Number → Messaging "A message comes in": `POST {PUBLIC_BASE_URL}/twilio/sms`. Verify status/callback routing and opt-out configuration as well.
5. Set `FORWARD_TO_PHONE` to the owner's cell, or keep the shop's existing number and set *conditional call forwarding (no-answer)* on the carrier to the Twilio number, leaving `FORWARD_TO_PHONE` empty. Calls ring for `RING_TIMEOUT_SECONDS`; unanswered calls do **not** grant SMS permission. A missed caller with a written grant gets the text-back; others hear a call-again-later message.
   An owner with an `owner_alerts` grant gets an instant buzz per missed call ("BUZZ <shop>: Missed call from <number> just now. ..."); `INSTANT_MISSED_BUZZ=0` turns it off.
6. Every live Twilio request requires a valid signature, matching account, and matching routing for the configured sender. `PUBLIC_BASE_URL` must match the public webhook URL exactly. Neither a demo flag nor `SKIP_TWILIO_VALIDATION` bypasses live checks.
7. Collect written client and owner opt-ins, record the separate grants, test blocks and restart persistence, then enable SMS only after documented review. See the [Pilot Checklist](docs/PILOT_CHECKLIST.md).

## Public tunnel
```bash
ngrok http 3000                                  # or:
cloudflared tunnel --url http://localhost:3000
```
For separately authorized signed-webhook testing only, put the HTTPS URL in `PUBLIC_BASE_URL`, restart, and review the webhook routing in Twilio. Do not expose unsigned local-demo mode. A tunnel does not satisfy registration or permission requirements.

## Stripe
Pricing: base plan starting at $49/mo, plus a per-paid-lead fee (default $12, `LEAD_FEE`) only when a caller books and pays the deposit; free 14-day trial; setup $99 (estimate), waived for the first 10 founding shops and on annual plans, charged only after the free trial. Booking deposits are direct charges on the shop's own Stripe account (below). The subscription stays on BuzzCall's platform account.

### Stripe Connect: deposit protection (`src/connect.js` + `src/deposits.js`)

- **Charge model: direct charges.** The customer Checkout Session is created on the shop's connected account. BuzzCall's balance does not receive the deposit. `DEPOSIT_APPLICATION_FEE_CENTS` defaults to 0. `DEPOSIT_AMOUNT_MAX` defaults to 50. `DEPOSIT_MODEL=platform_hold` leaves the old transfer code in place and unused by checkout.
- **Account choice (`CONNECT_DASHBOARD`).** Default `full` creates an Accounts v2 account with a full Stripe Dashboard, the shop paying Stripe's fees, and Stripe as the losses collector. `express` is opt-in and leaves dispute losses and Stripe fees with the platform. The dashboard cannot be changed after creation. Onboarding is an Account Link from a signed-in vendor session. One Stripe account cannot be linked to two shops. Admin approval is required before deposits go live.
- **Lead fee:** still booking bookkeeping (`due` / `waived` / `review`). It is not added to the Checkout Session unless `DEPOSIT_APPLICATION_FEE_CENTS` is set.
- **No-show check:** `NOSHOW_CHECK_HOURS` (default 12) after the appointment, never between 9pm and 8am shop-local. Texts only customers with an active written `customer_service` grant who have not opted out, at most once per booking. YES and an exact NO are recorded as reputation. They do not pause or release a direct charge. The customer is told BuzzCall does not hold the deposit.
- **No-show disputes (`src/disputes.js`):**
  - **Vendor check-in.** "I'm here" button in the vendor portal (Bookings, on the appointment day) and a signed one-tap link appended to the vendor's booking buzz (`Tap when you arrive: …/v/checkin/<token>`). Records time, IP and, only if the browser allows it, lat/lng/accuracy. Accepted from `CHECKIN_WINDOW_BEFORE_HOURS` (2) before to `CHECKIN_WINDOW_AFTER_HOURS` (6) after the start. Tokens are HMAC-SHA256 (`DISPUTE_TOKEN_SECRET`, else a random key in the platform store), name one booking in one shop, and expire.
  - **Customer NO.** Exact `NO` or `NOSHOW` only. The deposit stays a record on the shop's account. A check-in is stored next to the claim and called out in the admin alert. It does not hold BuzzCall money, because BuzzCall never had the money.
  - **Reply with proof.** On any NO the shop's `OWNER_PHONE` (with an `owner_alerts` grant) gets "[Customer] says you didn't show for [time]. Reply with a photo or details, or open <link> to respond." A text/MMS from that phone while a claim is open is attached as evidence (Twilio `MediaUrl`s stored as references, never downloaded). Portal page `/vendor/disputes/:id` and the signed link `/v/proof/<token>` (7 days) accept a note + one client-compressed photo (JPEG/PNG/WebP, ≤700 KB, 3 per claim, 40 per shop, stored in the shop store).
  - **Follow-up.** Direct mode does not text KEEP and does not auto-release. The vendor can still send proof. The old KEEP / auto-release path runs only when `DEPOSIT_MODEL` is `platform_hold`.
  - **Repeat claimers.** NO claims are counted across shops by a salted hash of the phone, and also by email and card fingerprint when the payment has them. `NOSHOW_FLAG_THRESHOLD` (2) within `NOSHOW_FLAG_WINDOW_DAYS` (90) flags the customer. "Require full prepay" is enforced on the next booking: the slot stays held until the deposit is paid, even if deposits are otherwise off.
  - **Admin.** `/admin/deposits` (`?shop=<vendor id>` for a vendor line) shows each claim's timeline (booking, payment, check-in with time/location, NO, proof, follow-up, KEEP/no reply, resolution) with Refund / Release, uploaded photos, and `/admin/deposits/:id/evidence.txt` (plain-text summary for Stripe dispute responses). Outcomes log stages: `vendor_checked_in`, `disputed`, `dispute_resolved_vendor`, `dispute_resolved_customer`.
- **Webhooks:** platform `{PUBLIC_BASE_URL}/stripe/webhook` is subscriptions. A payment-mode Checkout there is ignored. Connect `{PUBLIC_BASE_URL}/stripe/connect/webhook` (secret `STRIPE_CONNECT_WEBHOOK_SECRET`) fulfills the deposit and mirrors `charge.refunded`, `charge.dispute.*`, `account.updated`, and `account.application.deauthorized`. `event.account`, the stored session id, amount, and currency must all match.
- **Mock mode** (no `STRIPE_SECRET_KEY`): full flow on `/pay/mock/:id`, mock Connect onboarding, and admin **Demo: advance 24h / 48h** (`POST /admin/deposits/demo/advance`, also runs dispute follow-ups and auto-release, gated to mock + `DEMO_MODE` / non-production).
- **Go-live checklist (Stripe Dashboard):**
  1. Enable Connect; use **test** keys first (`sk_test_…`).
  2. Platform webhook → `{PUBLIC_BASE_URL}/stripe/webhook` for subscription events only. See `docs/GO_LIVE_PAYMENTS.md`.
  3. Connect webhook (Connected accounts) → `{PUBLIC_BASE_URL}/stripe/connect/webhook` with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `account.updated`, `account.application.deauthorized`.
  4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`. Leave `CONNECT_DASHBOARD=full`. Do not put live keys in Render until the test pass is done.
  5. Complete onboarding from the vendor portal, have an admin approve the account, book + pay with `4242…` on the connected account, and refund that payment from the shop's Stripe Dashboard. A NO reply should flag the booking and should not move money.


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
  - Owner SMS on `invoice.payment_failed` (with the portal link) and `trial_will_end` (Stripe sends the event 3 days before the trial ends) requires an active `owner_alerts` grant and passes the same central gate. Subscription or payment activity never grants SMS permission.
- **Service gating** (`billing.access()`): `trialing`/`active` means full service. `past_due` (after `PAST_DUE_GRACE_DAYS`), `canceled`, `unpaid`, `incomplete*` and `paused` mean inactive.
  - When inactive, the generic fallback (`INACTIVE_MODE=generic`, or `INACTIVE_MESSAGE`) is limited to one text per number per 24h and still requires an active `customer_service` grant, with no conversation, booking, or deposit. Unconsented or opted-out recipients get no application SMS; `silent` sends nothing.
  - Deposits already in progress still complete.
  - With no subscription on file, billing access stays active unless `BILLING_REQUIRE_SUBSCRIPTION=1`. `BILLING_ENFORCE=0` disables only billing-access enforcement, never the SMS permission gate; manual pilots still require recorded grants.
- **Status:** `/admin` shows a Subscription section at the top. `GET /billing/status` (admin) returns JSON, and `/health` shows `billing` and `serviceActive`.
- **Mock mode** (no `STRIPE_SECRET_KEY`): `/api/checkout` returns `/billing/mock/checkout/:id`. Its form posts to `/billing/mock/checkout/:id/complete`, which starts the trial, charges the mock setup fee on monthly, and fires the same events through the same handler.
  - Admin-only controls: `POST /billing/mock/advance {days}` moves a mock clock and fires `trial_will_end`, renewals, and period-end cancellation. `POST /billing/mock/fail-next {on}` makes the next renewal fail. `POST /billing/mock/update-card` pays the open invoice. `GET /billing/mock/portal` is the mock portal.
  - Mock proration credits unused time on the old plan and charges the new plan for a full new period; any negative remainder becomes account credit. Amounts come from `MOCK_PRICE_*`.
  - Legacy demo: `bash scripts/demo_billing.sh` is designed to use its own server on `:3077` and throwaway `DATA_DIR` for founding-shop, monthly/annual, cancellation, and lifecycle examples. It needs manual consent setup or a later update for SMS-dependent checks; old transcripts and successful completion are not guaranteed. `/billing/mock/primary` picks which mock shop drives billing access; the billing APIs accept an optional `sub`.
- **Stripe dashboard setup (live):**
  1. Create a Product with a monthly and a yearly recurring Price, plus an optional one-time setup Price, and put their ids in the env.
  2. Turn on the Customer Portal (Settings → Billing → Customer portal): allow payment-method updates, invoice history, and cancel *at end of billing period*. If you want switching in the portal, add both Prices to its plan-switching list.
  3. Add a webhook endpoint for the events above.
  4. Under Billing → Subscriptions and emails, pick the retry schedule and what happens after all retries fail (cancel or mark unpaid). Both count as inactive here.
  5. Optionally enable the trial-ending reminder email.

## Storage failures and crash recovery

The single-process JSON store persists `smsSessionClean=false` in the shop's durable store (Postgres in production; `DATA_DIR` files only for local/file use) before accepting traffic. A graceful SIGTERM/SIGINT drains requests and marks a healthy session clean. After a crash, forced exit, or failed consent write, SMS and new grants remain blocked on restart until reviewed recovery; old on-disk grants cannot silently reactivate. Failed revocations are retained in memory for suppression-only persistence retries. Startup fails if it cannot persist the safety marker.

Keep `SMS_ENABLED=0`, reconcile missing opt-outs against provider records and external evidence, record missing revocations, then use the authenticated JSON `POST /api/consent` recovery action with `acknowledgment: suppression_history_reviewed`. Review `recoveryRequired` and `persistenceFailed` in authenticated `GET /api/consent`. Recovery grants no permission and must not clear recipient revocations or provider blocks. See [the recovery procedure](docs/SMS_OPERATIONS.md#crash-and-storage-error-recovery). Never run multiple processes against the same store (`DATABASE_URL` or `DATA_DIR`) or edit safety markers to bypass review.

## Limits / next steps
Multiple isolated vendor stores run in one application process. **Run only one application instance/worker:** the existing JSON-document storage keeps an in-memory cache and is not safe for concurrent writers across instances. No automatic legacy-to-vendor migration, email delivery for invitations, or outbound SMS retry queue is included. Vendor onboarding does not establish SMS permission or carrier approval; complete the consent and provider checks before live use. Evidence custody, retention/deletion review, customer registration checks, and approval to enable SMS are operator responsibilities, not automated compliance checks. The application records grants/revocations and gates sends; Twilio standard filtering and optional Advanced Opt-Out are additional delivery controls, not substitutes for local revocation. Advanced Opt-Out is disabled by default. An `OptOutType` notification must not trigger a duplicate application reply.

Documentation checks: `node --test tests/consent-docs.test.js`. These test static claims only, not runtime enforcement, legal sufficiency, or carrier status. Run the source regression tests and pilot checks separately before launch.

## Persistence (restart-proof setups and config)

Platform and legacy state lives in files under `DATA_DIR` (`db.json`, `config.json`). Vendors use private `shops/<id>/` directories and distinct `shop:<id>:db` / `shop:<id>:config` Postgres keys; they never load legacy data as their own. Vendor database connections share a bounded pool. Graceful shutdown drains requests and flushes both platform and vendor stores before exiting. On hosts with an ephemeral filesystem (Render free plan) those are wiped on every restart/redeploy/spin-down. Set `DATABASE_URL` to a Postgres connection string and the same two JSON documents are stored in a `buzz_kv` table instead (created automatically; the first boot seeds it from any existing files). Consent grants/revocations and the SMS session-clean marker live in the same store, so production requires Postgres via `DATABASE_URL`; a grant is visible only after a successful durable write. Writes are debounced (~200 ms) and flushed on SIGTERM. Opt-outs, grants and START delivery-block clears skip the debounce and are written immediately. If `DATABASE_URL` is set but Postgres is unreachable at boot, the app falls back to file storage so the line keeps answering; in production it logs a loud warning and sends an owner alert. In production with `DATABASE_URL` set this is fatal instead, with no flag needed (retries `REQUIRE_POSTGRES_RETRIES`, default 5, 3 s apart, then exits so Render keeps the previous deploy or restarts); `REQUIRE_POSTGRES=1` extends that to a missing `DATABASE_URL`. If writes fail after boot, opt-outs are also appended to `DATA_DIR/optout-spill.jsonl` (merged at the next boot), `/health` shows `storageState: "degraded"`, and the owner is alerted once per outage. Admins see the full storage state on `/health` (with credentials) and at the top of `/admin`. Public `/health` shows only `storageState: "ok"|"degraded"`; the backend (`storage: "file"|"postgres"`) and `storageDetail` are in the admin view only (send Basic auth). Grants and START delivery-block clears are never written to the spill file, and such lines are ignored when it is merged, so the file can only add opt-outs (the safe direction). START never restores revoked permission in any case. `DATA_DIR` and `SPILL_DIR` must be absolute paths in production and may not point inside the app folder (except the default `data/`) or `public/`; a refused value is ignored with a loud warning (shown on admin `/health` and `/admin`) and the safe default is used (`<app>/data`, or `DATA_DIR` for the spill file). Folders are created `0700` and files `0600`, and a group- or world-writable folder is flagged. Note `sms.log` is a log only and stays file-based. Tests: `tests/storage.test.js` (set `TEST_DATABASE_URL` to also exercise a real database).

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
- Render env: `NODE_ENV=production`, `DATABASE_URL` (the app refuses to start without Postgres when it is set), a 20+ character `ADMIN_PASSWORD` (plus `ADMIN_USERNAME`, `ADMIN_PASSWORD_STRICT=1`), `OWNER_PHONE`, `PUBLIC_BASE_URL`, `SMS_CONSENT_BUSINESS_ID`, and `SMS_ENABLED=0` until the reviewed launch gate. Never set `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` there. Remove `DEMO_MODE` once Stripe/Twilio are live.
- Twilio console: Geo-Permissions US/Canada only, SMS Pumping Protection on. Keyword replies: Twilio's standard opt-out filtering handles exact STOP/START/HELP keywords; when Twilio reports `OptOutType`, the app does not send a duplicate reply. App-generated keyword replies (`KEYWORD_REPLIES=app`, the default) still pass the permission gate, so a revoked recipient gets no application STOP or START confirmation. Advanced Opt-Out is disabled by default; if you enable its auto-replies, set `KEYWORD_REPLIES=twilio` so exact keywords are left to Twilio.
- **Written SMS permission (A2P 10DLC):** there is no press-1 voice offer and a missed call never texts on its own. A missed caller with a recorded written `customer_service` grant (and `SMS_ENABLED=1`) gets the text-back; everyone else hears a polite message to call again later and is not texted. Record grants with authenticated `POST /api/consent` (`shopId` for a vendor shop); see [SMS Operations](docs/SMS_OPERATIONS.md). `VOICE_CONSENT_PROMPT` and `VOICE_CONSENT_SPANISH` are no longer used. No caller text is ever sent without a shop name (`BUSINESS_NAME`); blocked sends alert the platform admin.
- **Owner grants:** the owner/alert cell needs its own written `owner_alerts` grant, or it receives no missed-call buzzes, booking alerts, billing notices, or SMS sign-in/OTP codes.
- **Public SMS page per shop:** `/s/<slug>/sms` (slug = shop name lowercased, words joined by `-`; a second shop with the same name gets `-<first 6 of its id>`). It describes written opt-in collected outside SMS; use it as the A2P campaign's opt-in proof URL. A campaign already published with a press-1 message flow or opt-in proof must be updated with the carrier before enabling SMS (operator action; not done by this branch).
- **Area codes:** text-backs go only to US/Canada area codes in `src/areaCodes.js` (NANPA list, refreshed yearly; a test fails when it is ~12 months old). If the shop serves callers from a code that is skipped (a brand-new overlay, or Puerto Rico 787/939, USVI 340, Guam 671), set `TEXT_EXTRA_AREA_CODES=787,939`. An owner with an `owner_alerts` grant gets a daily text counting callers skipped for their area code.
- Check admin `/health` (with Basic auth) shows `storage: "postgres"`, `storageState: "ok"`, `smsEnabled: false` until the reviewed launch gate, and the boot log shows `[store] postgres backend ready` and `fail-closed ON`.
- Review caps and retention: `OUTBOUND_SHOP_MAX_PER_HOUR` (100), `OUTBOUND_SHOP_MAX_PER_DAY` (300), `OUTBOUND_MAX_PER_HOUR` (200), `OUTBOUND_MAX_PER_DAY` (500), `RETENTION_DAYS` (365), `BOT_PAUSE_HOURS` (72).
- Complete the [Pilot Checklist](docs/PILOT_CHECKLIST.md) before setting `SMS_ENABLED=1`.
