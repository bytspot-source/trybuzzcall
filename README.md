# BuzzCall (TryBuzzCall) — MVP

BuzzCall helps Georgia plumbers and HVAC shops (**Home Services**) and, with `VERTICAL=braiders`, Atlanta hair braiders (**Braiders**) handle missed calls and bookings. **A missed call is not SMS consent. SMS_ENABLED defaults off.** Automatic text-back is available only for a recipient with a recorded, active `customer_service` grant for the configured business and sender. Owner texts separately require an `owner_alerts` grant. It does not do spam filtering.

## SMS permission and launch boundary
This branch documents a conservative recorded-permission implementation, **not a compliance certification or carrier approval**. Verify the implementation and deployed version against [SMS Operations](docs/SMS_OPERATIONS.md) and the [Pilot Checklist](docs/PILOT_CHECKLIST.md) before enabling live SMS. The public [consent page](public/sms-consent.html), [SMS Terms](public/terms.html#sms), and [Privacy Policy](public/privacy.html) remain legal drafts pending counsel review.

- Obtain and retain actual written opt-in evidence outside the application in secured storage. An authenticated operator records the recipient, purpose, consent timestamp, disclosure version, and a non-secret evidence reference; the reference alone is not proof of consent.
- Grants are scoped to one stable `SMS_CONSENT_BUSINESS_ID`, the configured E.164 `TWILIO_PHONE_NUMBER`, and either `customer_service` or `owner_alerts`. Do not transfer consent between businesses or senders. Review changed identities before collecting new permission.
- **No automatic grants** from missed calls, inbound messages, START, payments, waitlist signup, or merely providing a number. Do not send an unsolicited SMS to request initial opt-in. Twilio permits a limited response to an inbound message within its scope; this application deliberately requires recorded written permission even for that exchange and does not infer recurring consent.
- Every application SMS uses the central permission gate, including booking/deposit confirmations, owner alerts, billing reminders, HELP replies, and inactive-service messages. The feature descriptions below are conditional on that gate; a booking or payment does not guarantee a text. Provider-generated opt-out/help replies are separate.
- STOP keywords and natural-language requests revoke **all purposes** locally. START only clears a delivery block; it never restores grants. UNSTOP and YES have the same limited behavior. After opt-out, obtain fresh evidence and record a fresh grant. If Twilio has blocked delivery, the recipient must explicitly opt back in with the provider first; operators must not bypass that block.
- Voice fallback must not claim that a text was sent; it advises the caller to call again. Automatic text-back is only for an already permissioned recipient. Customers may use the business's phone service without agreeing to SMS; consent is not a condition of purchase.
- Messages are nonmarketing. Message frequency varies; message and data rates may apply. Reply STOP to opt out or HELP for help.

### Official sources versus application safeguards
The following official sources describe provider requirements, not approval of BuzzCall or any particular customer. Legal, customer-identity, campaign, sender, and evidence review remain external launch prerequisites.

- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) (April 13, 2026 version): prior express consent and proof; written consent for downstream software customers; inbound SMS permits a scoped exchange, not general recurring messages; consent cannot be transferred.
- [A2P 10DLC ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv): register the actual customer identities, not every shop under a blanket platform brand.
- [A2P 10DLC quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart): verify the campaign and associate its sending number; do not solicit initial opt-in by unsolicited SMS.
- [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out): standard keyword filtering is distinct from Advanced Opt-Out, which is disabled by default. When Twilio sends `OptOutType` START, STOP, or HELP, the provider has already replied; the application must not duplicate that reply.

## Stack
Node 20 + Express. Leads, bookings, and consent records use a JSON store under `DATA_DIR` (default `data/db.json`), with no native dependencies. Uses the Twilio SDK, optional OpenAI (via fetch), and the Stripe SDK. Protect the data directory and logs; on Render, use a persistent disk for `DATA_DIR` and verify grants and revocations survive a restart.

1. Twilio sends a validated call webhook to `/twilio/voice` and forwards the call when configured.
2. On a missed call, `/twilio/voice/status` may start text-back **only after the central gate permits `customer_service`**. Otherwise there is no automatic SMS.
3. Validated inbound SMS reaches `/twilio/sms`; incoming content does not itself grant permission. Permitted conversations collect name, need, and callback window or booking choice.
4. Owner notifications separately pass the gate for `owner_alerts`; being the owner or setting `OWNER_PHONE` does not grant permission.

### Optional booking + deposit
All texts in this flow require the recipient's active grant and pass the central gate, including messages triggered by a later payment. With `BOOKING_ENABLED=1`, after the *need* step a permissioned caller can receive the 3 next open slots (from `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BUSINESS_TZ`) and replies `1`/`2`/`3`, or `callback` to fall back to the classic callback-window flow.
- **No deposit** (`DEPOSIT_ENABLED` off): the slot is booked at once, the caller gets a confirmation, and the owner gets `BOOKED (no deposit)`.
- **Deposit** (`DEPOSIT_ENABLED=1`, `DEPOSIT_AMOUNT` default 49): the slot is *held* for `HOLD_MINUTES` and the caller gets a pay link. The owner gets `slot held, deposit pending`.
  - With `STRIPE_SECRET_KEY`, the link is a Stripe Checkout Session (mode `payment`, `metadata.bookingId`). Point a Stripe webhook at `{PUBLIC_BASE_URL}/stripe/webhook` (event `checkout.session.completed`). `STRIPE_WEBHOOK_SECRET` and a valid signature are mandatory; unsigned events are rejected. Only a verified event with `payment_status=paid` confirms the deposit. Local simulations use the explicit mock routes, not unsigned webhooks.
  - Without a key, the link is `{PUBLIC_BASE_URL}/pay/mock/:id`, and visiting it marks the deposit paid.
  - On payment the booking becomes `confirmed`, the caller gets a confirmation text, and the owner gets `BOOKED + PAID $49: name, need, slot, lead fee $12, tel:…`.
- **Per-paid-lead fee** (`LEAD_FEE`, default 12 USD): charged to the shop only when a caller books *and* pays the deposit. Recorded on the booking as `lead_fee` + `lead_fee_status` when it is marked paid:
  - **Stripe Connect** (`STRIPE_CONNECT_ACCOUNT_ID=acct_…` set): the deposit Checkout Session is a destination charge: `payment_intent_data.transfer_data.destination` = the shop's account and `application_fee_amount` = `LEAD_FEE*100` (capped at the deposit). Status `collected`.
  - **No Connect** (including the mock flow without Stripe keys): the deposit goes to the platform account and the fee is recorded with status `due` for monthly invoicing.
  - `LEAD_FEE_WAIVED=1` (free pilot): no application fee; status `waived`, fee $0. A payment that arrives after its slot was lost (`paid_conflict`) gets status `review`.
  - `/admin` shows the lead-fee total (due / collected / waived / review) and the fee on each booking. Invoicing `due` fees and refunding application fees on deposit refunds are still manual (TODO).
- Files: `src/booking.js` (slots, holds, Stripe/mock links, Connect params, lead fees, mark-paid).
- Bookings live in `data/db.json` → `bookings`. A slot that is `held` (and not expired) or `confirmed` is never offered or booked again, and the hold is re-checked at pick time. Expired holds release the slot. A payment that arrives after expiry, when someone else has taken the slot, is flagged `paid_conflict` and the owner is told to reschedule or refund.
Files: `src/server.js` (routes), `src/billing.js` (shop subscription billing), `src/agent.js` (conversation; OpenAI if `OPENAI_API_KEY`, else plumber/HVAC templates), `src/sms.js` (Twilio or log-only), `src/store.js`, `public/index.html` (landing page and waitlist).

### Verticals (`VERTICAL`)
- `home_services` (default): plumber/HVAC wording (`BUSINESS_VERTICAL=plumber|hvac`), flow *name → need → slot*, fixed `SLOT_MINUTES` blocks, $49 deposit, $12 lead fee, urgent-keyword flag.
- `braiders`: warm stylist wording in first person, no urgent/emergency language. Flow: *name → style from the `SERVICES` menu (plus optional size/length notes) → preferred day → 3 start times → hold + deposit*. Each caller can also reply `call` for a callback instead.
  - `SERVICES="Knotless braids:360,Box braids:300,Locs retwist:120,Twists:180"` (name:minutes). Start times are spaced `SLOT_STEP_MINUTES` apart (default 60). The whole appointment must fit inside `BUSINESS_HOURS`, and a time is never offered if it overlaps a held or confirmed booking.
  - Defaults when the var is unset: `BUSINESS_HOURS=09:00-19:00`, `BUSINESS_DAYS=1,2,3,4,5,6` (Mon-Sat), `DEPOSIT_AMOUNT=50` (credited toward the service), `LEAD_FEE=5`. Explicit values always override, so remove the home-services values from `.env` when you switch.
  - Preferred day understands `today`, `tomorrow`, weekday names, `10/24`, `Oct 24`. Anything else (like `soonest`) means the earliest opening. If that day is full, the caller gets the closest openings after it.
  - `BOOKING_LINK` (optional): the stylist's own Booksy/StyleSeat/GlossGenius link, added to the time-offer and callback texts.
  - Owner texts: `BUZZ …: time held, deposit pending …`, then `BOOKED + PAID: <name>, <service>, <time>, $50 deposit. Notes: <size/length>. tel:…`.
  - Legacy demo: `bash scripts/demo_braiders.sh` attempts a booking + mock deposit and callback using a temporary server if needed. It has not been established as compatible with the new webhook and consent requirements; do not expect SMS or the old transcript without manual permission setup or a later script update. Only run one server against a data directory at a time.

## Run locally (SMS off by default)
Install declared dependencies with `npm install`, configure local settings from `.env.example`, and run `npm start` for http://localhost:3000. Admin page: http://localhost:3000/admin (Basic authentication using `ADMIN_PASSWORD`; keep credentials out of URLs, examples, and logs).

Unsigned **local-only** Twilio simulations require `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1`, no live credentials, and `NODE_ENV` other than `production`. This exception never authorizes an unsigned live Twilio request. `SKIP_TWILIO_VALIDATION` no longer bypasses live validation. Do not expose an unsigned-demo server through a public tunnel.

Legacy scripts `scripts/demo_simulate.sh`, `scripts/demo_billing.sh`, and `scripts/demo_braiders.sh` may need manual consent setup or later updates. They no longer text by default, and their previous booking/SMS transcripts are not guaranteed. To exercise SMS locally, use isolated test data, an explicit local configuration, and the authenticated consent workflow in [SMS Operations](docs/SMS_OPERATIONS.md). Log-only SMS still passes the permission gate. Protect `DATA_DIR` and its SMS logs; do not treat a log entry as live delivery or carrier approval.

## Env vars
See `.env.example`. For SMS, explicitly configure `SMS_ENABLED` (default off), `SMS_CONSENT_BUSINESS_ID` (stable per-business slug), and `TWILIO_PHONE_NUMBER` (E.164 sender); neither display names nor request-supplied identities replace these. Keep SMS disabled until the reviewed launch checks pass. Other key ones: `BUSINESS_NAME`, `VERTICAL` (home_services|braiders), `BUSINESS_VERTICAL` (plumber|hvac), braiders: `SERVICES`, `SLOT_STEP_MINUTES`, `BOOKING_LINK`; `OWNER_PHONE`, `FORWARD_TO_PHONE`, `TWILIO_*`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_BASE_MONTHLY/_ANNUAL`, `STRIPE_PRICE_ID_SETUP`, `TRIAL_DAYS`, `ANNUAL_UPGRADE_PRORATION`, `MONTHLY_DOWNGRADE_PRORATION`, `BILLING_PORTAL_RETURN_URL`, `BILLING_ENFORCE`, `BILLING_REQUIRE_SUBSCRIPTION`, `PAST_DUE_GRACE_DAYS`, `INACTIVE_MODE`, `INACTIVE_MESSAGE`, `MOCK_PRICE_*`, `DATA_DIR`, `LEAD_FEE`, `LEAD_FEE_WAIVED`, `STRIPE_CONNECT_ACCOUNT_ID`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`; booking: `BOOKING_ENABLED`, `BUSINESS_TZ`, `BUSINESS_HOURS`, `BUSINESS_DAYS`, `SLOT_MINUTES`, `BOOKING_LEAD_MINUTES`, `DEPOSIT_ENABLED`, `DEPOSIT_AMOUNT`, `HOLD_MINUTES`, `STRIPE_WEBHOOK_SECRET`.

## Twilio setup (operator review required; no approval implied)
1. Keep `SMS_ENABLED` off while reviewing the actual customer's identity and opt-in process. Any number purchase, carrier submission, fee, or deployment needs separate authorization; this document performs none of them.
2. For US A2P 10DLC, use the actual business's customer profile and brand, not a blanket TryBuzzCall platform brand. Verify external brand/campaign approval and associate the approved E.164 sender with that campaign/Messaging Service. Registration alone is not consent or guaranteed delivery.
3. Number → Voice "A call comes in": `POST {PUBLIC_BASE_URL}/twilio/voice`.
4. Number → Messaging "A message comes in": `POST {PUBLIC_BASE_URL}/twilio/sms`. Verify status/callback routing and opt-out configuration as well.
5. Set `FORWARD_TO_PHONE` to the owner's cell, or review conditional no-answer forwarding from the shop's existing number. Calls ring for `RING_TIMEOUT_SECONDS`; unanswered calls do **not** grant SMS permission.
6. Every live Twilio request requires a valid signature, matching account, and matching routing for the configured sender. `PUBLIC_BASE_URL` must match the public webhook URL exactly. Neither a demo flag nor `SKIP_TWILIO_VALIDATION` bypasses live checks.
7. Collect written client and owner opt-ins, record the separate grants, test blocks and restart persistence, then enable SMS only after documented review. See the [Pilot Checklist](docs/PILOT_CHECKLIST.md).

## Public tunnel
```bash
ngrok http 3000                                  # or:
cloudflared tunnel --url http://localhost:3000
```
For separately authorized signed-webhook testing only, put the HTTPS URL in `PUBLIC_BASE_URL`, restart, and review the webhook routing in Twilio. Do not expose unsigned local-demo mode. A tunnel does not satisfy registration or permission requirements.

## Stripe
Pricing: base plan starting at $49/mo, plus a per-paid-lead fee (default $12, `LEAD_FEE`) only when a caller books and pays the deposit; free 14-day trial; setup $99 (estimate), waived for the first 10 founding shops and on annual plans, charged only after the free trial. Deposits for bookings use one-off Checkout Sessions plus `/stripe/webhook` (see above). For automatic lead-fee collection, onboard the shop as a Stripe Connect account and set `STRIPE_CONNECT_ACCOUNT_ID`.

### Shop subscription billing (`src/billing.js`)
Built on the installed `stripe` npm package **16.12.0** (API version `2024-06-20`, where `current_period_end` is on the subscription).
- **Signup:** `POST /api/checkout {plan: "monthly"|"annual", email?}` creates a Checkout Session with `mode: "subscription"`, `payment_method_collection: "always"` (card required), and `subscription_data.trial_period_days = TRIAL_DAYS` (default 14). It also sets `trial_settings.end_behavior.missing_payment_method = "cancel"`. There's no `billing_cycle_anchor`, so the cycle anchors on signup and the first paid period starts when the trial ends (no partial first month).
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

The single-process JSON store persists `smsSessionClean=false` before accepting traffic. A graceful SIGTERM/SIGINT drains requests and marks a healthy session clean. After a crash, forced exit, or failed consent write, SMS and new grants remain blocked on restart until reviewed recovery; old on-disk grants cannot silently reactivate. Failed revocations are retained in memory for suppression-only persistence retries. Startup fails if it cannot persist the safety marker.

Keep `SMS_ENABLED=0`, reconcile missing opt-outs against provider records and external evidence, record missing revocations, then use the authenticated JSON `POST /api/consent` recovery action with `acknowledgment: suppression_history_reviewed`. Review `recoveryRequired` and `persistenceFailed` in authenticated `GET /api/consent`. Recovery grants no permission and must not clear recipient revocations or provider blocks. See [the recovery procedure](docs/SMS_OPERATIONS.md#crash-and-storage-error-recovery). Never run multiple processes against the same `DATA_DIR` or edit safety markers to bypass review.

## Limits / next steps
Single-tenant (one business per deploy, one subscription), JSON store, no retry queue for SMS. Evidence custody, retention/deletion review, customer registration checks, and approval to enable SMS are operator responsibilities, not automated compliance checks. The application records grants/revocations and gates sends; Twilio standard filtering and optional Advanced Opt-Out are additional delivery controls, not substitutes for local revocation. Advanced Opt-Out is disabled by default. An `OptOutType` notification must not trigger a duplicate application reply.

Documentation checks: `node --test tests/consent-docs.test.js`. These test static claims only, not runtime enforcement, legal sufficiency, or carrier status. Run the source regression tests and pilot checks separately before launch.
