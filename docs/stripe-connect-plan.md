# Stripe Connect plan: deposits go to the shop owner, not BuzzCall

Status: research + plan only (no code changes, no Stripe account actions, no signups).
Written: 2026-10-23 (America/New_York). Entity: TryBuzzCall LLC (Georgia LLC, wholly owned by Bytspot Inc.).
Everything marked "ESTIMATE" or "VERIFY" must be re-checked against live Stripe pages before launch.

## 0. Recommendation (short)

**Use Standard-equivalent connected accounts + direct charges.**
Each shop owner gets their own Stripe account, connected to the TryBuzzCall platform. The deposit Checkout Session is created *on the owner's account* (`Stripe-Account` header). Optionally keep the per-paid-lead fee as `application_fee_amount`.

Why it fits a tiny SMB pilot:
- The owner is merchant of record, so the deposit lands in the owner's Stripe balance and never in BuzzCall's. This is the plainest way to meet "deposits must go to each shop owner, not be held by BuzzCall."
- Refunds and chargebacks debit the owner's balance, not BuzzCall's. That matches Terms §5 and `public/refunds.html`. Stripe covers loss liability for these accounts if the owner can't pay.
- Stripe bills processing fees to the owner directly. There are no Connect fees for the platform, and Stripe issues 1099-Ks.
- The owner gets the full Stripe Dashboard to issue refunds (including partials for the "trip fee" case), see disputes and set payouts. BuzzCall does not need to build refund or dispute tooling for the pilot.
- It is the lowest integration effort (hosted onboarding via Account Links, no KYC UI).

**Important finding about the current code:** `src/booking.js` already has a *destination charge* path, enabled by `STRIPE_CONNECT_ACCOUNT_ID`. It has three problems:
1. Destination charges are created on the platform. Funds sit in BuzzCall's balance first. BuzzCall's balance is debited for refunds and chargebacks, and BuzzCall pays the Stripe fees.
2. This contradicts Terms §5, which says the shop is responsible for refunds and chargebacks.
3. With no `STRIPE_CONNECT_ACCOUNT_ID`, `depositLink()` still creates a normal platform-account charge. That is exactly what you want to stop. The new design should **fail closed**.

Sources: https://docs.stripe.com/connect/charges and https://docs.stripe.com/connect/best-practices

---

## 1. Connect model

### 1.1 Account types (Stripe is moving to "controller properties" / Accounts v2)
Stripe's docs now say new platforms should use controller properties or the Accounts v2 API instead of the legacy types. They call Standard/Express/Custom a "legacy" configuration.
- https://docs.stripe.com/connect/accounts
- https://docs.stripe.com/connect/migrate-to-controller-properties
- https://docs.stripe.com/connect/accounts-v2

A "Standard" account is the default of `POST /v1/accounts` with no controller args. Its properties are:
- `controller.losses.payments=stripe`
- `controller.fees.payer=account`
- `controller.requirement_collection=stripe`
- `controller.stripe_dashboard.type=full`

For this pilot: use **v1 Accounts with default (Standard-equivalent) controller properties**, which the installed `stripe` SDK 16.x supports.
- v2 Accounts are shown with Stripe-Version `2026-09-30.preview`, and v2 needs a newer SDK.
- Account type and dashboard type can't be changed after creation. Stripe's platform profile recommends a configuration, so confirm it before building. VERIFY.
- v2 equivalent of the same setup: `dashboard: full`, `fees_collector: stripe`, `losses_collector: stripe`.

| | Standard (rec.) | Express | Custom |
|---|---|---|---|
| Charge types | Direct | Destination / separate / (direct, discouraged for legacy) | same as Express |
| Fraud/dispute liability | Connected account on direct charges (platform on destination) | Platform | Platform |
| Onboarding | Stripe-hosted | Stripe-hosted | Platform or Stripe |
| Owner Dashboard | Full Stripe Dashboard | Express Dashboard | None |
| Integration effort | Lowest | Low | Significantly higher |
| Extra Connect cost | none (Stripe-handles-pricing) | yes ("additional cost" per Stripe) | yes |

Source: the comparison table at https://docs.stripe.com/connect/accounts.
- Express/Custom make BuzzCall responsible for disputes and fraud and for negative balances. They also push BuzzCall toward the KYC/risk work you are trying to avoid.
- Destination charges (even on Standard) make BuzzCall's balance bear refunds and disputes ("Refunds and chargebacks reduce your platform's balance").

### 1.2 Direct vs destination charges for this use case
- **Direct** (recommended): the charge is on the owner's account and the owner's balance goes up. BuzzCall's balance only gets the application fee. Refunds and chargebacks reduce the owner's balance. Stripe says it is "best for SaaS", and BuzzCall is a SaaS tool that texts for a shop. Customers transact with the shop, and the shop's branding appears in Checkout.
- **Destination**: customers transact with the platform. Funds land in the platform balance and are transferred out. The platform pays Stripe fees and carries refunds and disputes. This suits marketplaces, which BuzzCall is not.

Sources: https://docs.stripe.com/connect/charges, https://docs.stripe.com/connect/direct-charges (Checkout variant: https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted)

### 1.3 Who is liable (recommended model)
| Item | Who | Source |
|---|---|---|
| Refund | Stripe debits the owner's balance when the refund is created. If the balance is short, the refund goes `pending` until funds arrive. | /connect/charges |
| Dispute / chargeback amount | Debited from the owner's balance, not the platform's. | /connect/charges |
| Dispute fees | Owner (fee payer = account). | /connect/direct-charges-fee-payer-behavior |
| Owner can't cover a negative balance | Stripe (`losses.payments=stripe`). The platform is still liable for its own account's negative balance only. | /connect/migrate-to-controller-properties, /connect/best-practices |
| Stripe processing fees | Owner, billed by Stripe directly. | /connect/direct-charges-fee-payer-behavior |
| Application fee on a refund | **Not refunded automatically.** The platform must pass `refund_application_fee=true`, or the owner loses that amount. | /connect/direct-charges |

Caveats:
- BuzzCall can still be pulled into customer complaints, since `refunds.html` routes to BuzzCall support.
- Stripe's Services Agreement puts refunds, disputes and fraud losses on the account holder (Stripe Payments Terms §5.2, §11): https://stripe.com/legal/connect

### 1.4 Application fee (optional)
- The app's per-paid-lead fee (`LEAD_FEE`: $12 jobs, $5 appointments) maps to `payment_intent_data.application_fee_amount` on the direct-charge Checkout Session.
- The amount must be positive and **less than** the charge. The current code caps at the full deposit (`Math.min(fee, amount)`). Cap at `amount - 1¢` instead.
- No additional Stripe fee is charged on the application fee. It goes to the platform balance. The owner's net is deposit − Stripe fee − app fee.
- It shows in Dashboard → Collected fees as an ApplicationFee object.
- Pilot: keep `LEAD_FEE_WAIVED=1`, so no application fee at all.
- Pricing caution: a $12 fee on a $20 deposit leaves the owner about $7 (see §2).

### 1.5 Payout timing
- **First payout:** after the first live payment, typically 7–14 days depending on industry, country and risk.
- **Initial settlement timing (US):** 2 business days. Later payouts follow the owner's own schedule, with daily automatic as the default.
- **Owner control:** with the full Dashboard, the owner manages their schedule, bank account and Instant Payouts (eligibility applies). Sources: https://docs.stripe.com/payouts, https://docs.stripe.com/connect/manage-payout-schedule, https://docs.stripe.com/connect/design-an-integration

### 1.6 What the shop owner has to do
1. Click "Connect Stripe to receive deposits" in the BuzzCall admin. This opens a **Stripe-hosted onboarding** link (Account Links, single-use, short-lived).
2. Provide business and identity verification info and a bank account or debit card for payouts, and accept Stripe's Connected Account Agreement. Stripe collects these. Payouts are blocked without a verified external account. Sources: /connect/standard-accounts, /connect/design-an-integration
3. Come back via `return_url`. BuzzCall then checks `charges_enabled` / `details_submitted`. Returning does *not* mean verification is complete (/connect/standard-accounts).
4. Afterwards, use their own Stripe Dashboard for refunds, disputes and payouts.

VERIFY in test mode: exact fields shown per business type, and whether an owner with an *existing* Stripe account can link it through the Account Links flow. If not, use OAuth, which is only available for Standard accounts on Accounts v1 and needs a Connect `client_id` (`ca_...`).

### 1.7 What TryBuzzCall LLC must set up
- **Platform account:** the Stripe account (user is finishing it). Business details must match the legal entity.
  - `public/terms.html` line 2 has a TODO: confirm the filed name and its own EIN match Terms, Privacy, the A2P 10DLC brand and Stripe.
  - Stripe will ask for verification and ownership information for a single-member LLC owned by Bytspot Inc. VERIFY with Stripe's onboarding, and ask the accountant.
- **Connect platform profile** (Dashboard → Connect → Get started / platform profile questionnaire).
  - Stripe uses it to recommend account and charge types. Doc order: register, verify business details, complete the platform profile, set brand (name, icon, color). Source: https://docs.stripe.com/connect/marketplace/essential-tasks
  - Approval is needed for live connected accounts. The top-ups doc says "In all markets, you must complete KYC to get your platform profile approved" (https://docs.stripe.com/connect/top-ups). Third-party reports say review takes about 1–2 days or up to a few. That is **not from Stripe's own docs**, so treat it as unverified.
  - Test mode works before approval per third-party guides (unverified).
  - Review and the questionnaire can only be done by the account holder in the Dashboard.
- **Branding:** Connect Onboarding requires platform name, color and icon in Connect settings (/connect/standard-accounts). With direct charges, Checkout shows the *owner's* branding (/connect/direct-charges).
- **Terms for connected accounts** (https://docs.stripe.com/connect/updating-service-agreements):
  - Connected accounts must accept the Stripe Connected Account Agreement. Stripe's hosted onboarding includes that acceptance and the acquirer disclosure.
  - Stripe suggests adding to your Terms a link to the Services Agreement and Connected Account Agreement and a link to Stripe's Privacy Policy, and saying that accepting your terms includes accepting Stripe's agreement.
  - Stripe also says disclosures and consents may need lawyer review.
  - Edit candidates: `terms.html` §3/§5, `privacy.html`, `refunds.html` wording, setup-form consent (see §4).
- **Webhooks:** register a Connect webhook endpoint (scope "Connected accounts") and keep the existing platform endpoint for subscription billing. Source: https://docs.stripe.com/connect/webhooks
- **Keys:** Stripe API keys, test first (see §5).

---

## 2. Estimated Stripe fees (ESTIMATES)

Source: https://stripe.com/pricing and https://stripe.com/connect/pricing, both fetched 2026-10-23.
Re-check before launch. Actual rates can differ by account or by custom pricing.

Published rates:
- Domestic cards: **2.9% + 30¢** per successful charge.
- Dispute received: **$15** each. Dispute countered: **$15**, returned if you win.
- Refunds: no fee on cards, but the original processing fee is not returned (FAQ on the pricing page).
- Connect "Stripe handles pricing for your users" (what the recommended Standard setup gets): **no fees for the platform**, and Stripe collects processing fees from the connected account.
- Only if BuzzCall chose to handle pricing: $2 per monthly active account, and 0.25% + 25¢ per payout.
- 1099 fees ($2.99 e-file etc.) apply only in the "you handle pricing" column. Under the recommended model Stripe issues the 1099-K.

Per-deposit estimate under direct charges, owner pays Stripe's fee:

| Deposit | Stripe fee | Owner net (no app fee) | Owner net w/ $5 appt fee | Owner net w/ $12 job fee |
|---|---|---|---|---|
| $20 | $0.88 | $19.12 | $14.12 | $7.12 |
| $30 | $1.17 | $28.83 | $23.83 | $16.83 |
| $40 | $1.46 | $38.54 | $33.54 | $26.54 |
| $49 (default job) | $1.72 | $47.28 | n/a | $35.28 |
| $50 | $1.75 | $48.25 | $43.25 | $36.25 |

Note on the $12 job lead fee: it is 60% of a $20 deposit. Decide whether that is intended.

For comparison, under destination charges (the current code path), BuzzCall pays the Stripe fee, so about $0.88 on a $20 deposit. BuzzCall also carries the $15 dispute fee and refunds. The Stripe fee is not returned on refund.

---

## 3. App changes

### 3.1 Current state (from `src/`)
| Area | Today |
|---|---|
| Checkout creation | `booking.depositLink()` creates a Checkout Session on the platform key. `connectParams()` adds `transfer_data.destination` and `application_fee_amount` when `STRIPE_CONNECT_ACCOUNT_ID` is set. Otherwise it is a normal platform charge. |
| Mock mode | No `STRIPE_SECRET_KEY` → `/pay/mock/:id` marks the booking paid. `/pay/mock` returns 404 if a key is set. Billing has its own mock (`/billing/mock/*`). |
| Webhook | `POST /stripe/webhook` uses one secret (`STRIPE_WEBHOOK_SECRET`). `billing.handleEvent` handles subscription events first. `checkout.session.completed` and `async_payment_succeeded` call `onPaid(metadata.bookingId)`. If the secret is unset the JSON is trusted (dev only). |
| Config | `src/config.js` KEYS (setup-form/override values) do not include the connect account. It is env-only. Admin 'Apply to this line' writes only those KEYS to `config.json` or Postgres `buzz_kv`. State lives in `store.db`. |
| Refunds | **None in code.** README says "refunding application fees on deposit refunds … manual (TODO)". |
| Tests | `node --test tests/*.test.js`, about 109 tests. No test covers the Stripe session params. `site-http.test.js` blanks `STRIPE_CONNECT_ACCOUNT_ID` and checks `/health`. |

### 3.2 Changes
1. **Per-shop connected account state.** Store `store.db.stripeConnect = { accountId, mode:'live'|'test'|'mock', chargesEnabled, detailsSubmitted, payoutsEnabled, requirementsDue[], updatedAt }` in the db (not config override KEYS).
   - It mutates with webhooks and shouldn't be edited via the setup form.
   - Keep `STRIPE_CONNECT_ACCOUNT_ID` env as a manual override or seed.
   - Add `/health.connect` as the status (ready or not).
   - A new `src/connect.js` should wrap Stripe calls: create account, create account link, retrieve and refresh status.
2. **Onboarding flow (admin).** The admin dashboard (`/admin`, Basic auth) gets a "Deposit payouts" card with status and a button.
   - `POST /admin/connect/onboard` creates the account if missing (`stripe.accounts.create({})`, default controller props, with prefill of business name, URL and email from setup values).
   - Then `stripe.accountLinks.create({account, type:'account_onboarding', refresh_url, return_url})` and redirect.
   - `GET /admin/connect/refresh` (re-issues the link) and `GET /admin/connect/return` (re-fetch the account, update state).
   - Never email or text the link (Stripe: provide only to the authenticated account holder).
   - Setup form (`/setup`): add at most a "you'll connect Stripe after approval" note. Onboarding happens from admin or via an owner-facing link after the shop is set up.
3. **Checkout on behalf of the connected account.** In `depositLink()`:
   - Direct charge: `stripe.checkout.sessions.create({...}, { stripeAccount: acct })`. Drop `transfer_data`. Keep `payment_intent_data.application_fee_amount` (when not waived, and capped below the deposit) and `metadata.bookingId`.
   - **Fail closed:** if live mode and no ready connected account (`chargesEnabled`), do not create a platform-account charge. Return null so `server.js` already falls back to `heldNoLink`, which tells the customer the shop will follow up. Alert the owner "connect Stripe to take deposits".
   - Keep `expires_at`, `client_reference_id` and `success_url`. Save `connectAccount` and `stripeSessionId` on the booking.
4. **Webhooks.**
   - Add `POST /stripe/connect/webhook` (new route, also before the JSON parser, raw body). Use a separate secret `STRIPE_CONNECT_WEBHOOK_SECRET`. A Connect endpoint (scope "Connected accounts") has its own signing secret.
   - Direct-charge events carry a top-level `account`. **Require `event.account === store.db.stripeConnect.accountId`.** If several deployments share one platform, every Connect endpoint receives every connected account's events, so this filter is mandatory.
   - Handle `checkout.session.completed`, `checkout.session.async_payment_succeeded` and (new) `async_payment_failed`. Call `onPaid` for paid sessions. Handle `account.updated` (refresh status) and `account.application.deauthorized` (mark disconnected, alert). Optionally handle `charge.refunded` and `charge.dispute.created` to alert the owner and mark the booking.
   - Platform endpoint stays for billing (subscription events). Use `livemode` checks.
   - Sources: https://docs.stripe.com/connect/webhooks, https://docs.stripe.com/connect/direct-charges
   - Test locally with `stripe listen --forward-connect-to localhost:PORT/stripe/connect/webhook`.
5. **Refunds.**
   - **v1 (pilot): none in-app.** The owner refunds from their Stripe Dashboard. Mention that in the owner onboarding text, and in the owner alert text on paid bookings. The app only listens for `charge.refunded` to reflect the status.
   - Optional v2 (about 5h): an admin "Refund deposit" action for support cases. It uses the platform key with `stripeAccount`, creating `refunds.create({charge or payment_intent, amount?, refund_application_fee: true|false})`, and sets `booking.status='refunded'`. Follow `refunds.html`: full for job-trade cancellations, partial when the trip fee is kept, provider's policy for appointment trades.
   - Decide whether the lead fee is refunded on full deposit refunds (README says TODO). Per Stripe, a full refund with `refund_application_fee=true` returns the whole application fee, and a partial refund returns a proportional share.
   - "Deposit credited to final bill" needs no Stripe action. It is the owner's accounting. The deposit is a line on the booking, so the paid text and owner alert should say "$X deposit paid, deduct from final bill." Keep that wording in the owner alert.
6. **Mock mode kept.** No `STRIPE_SECRET_KEY` → no Stripe calls anywhere.
   - `accountId='acct_mock_…'`, `/admin/connect/onboard` shows a mock "Stripe onboarding" page that sets `chargesEnabled=true`.
   - `/pay/mock/:id` is unchanged. Bookings record `connectAccount='acct_mock_…'`.
   - A mock `account.updated` can be driven from tests.
   - In mock mode `depositLink` stays unchanged (no fail-closed, because there is no real money).
7. **Config / env.** Add `STRIPE_CONNECT_WEBHOOK_SECRET` and `STRIPE_CONNECT_ACCOUNT_ID` (optional seed). Update `.env.example`, README (Stripe section), and `docs/PILOT_CHECKLIST.md` (add "owner completed Stripe onboarding, `/health` connect=true, test deposit from a test card"). Remove the stale "destination charge" docs.
8. **Tests** (node:test, with a fake stripe client injected like `poolFactory` in storage tests):
   - `depositLink` direct-charge params: `stripeAccount` option, no `transfer_data`, `application_fee_amount` capped at `amount−1¢`, `LEAD_FEE_WAIVED` gives no fee.
   - Fail closed in live mode with no ready account (no platform-account session created).
   - Connect webhook: signature check, `event.account` mismatch rejected, `checkout.session.completed` → `onPaid` idempotent, `account.updated` updates state.
   - Onboarding routes behind admin auth, redirect URLs, mock onboarding.
   - Update `site-http` `/health` expectations. Regression of the existing 109 tests.
   - Manual E2E in Stripe test mode: create test connected account, onboard with test data, pay with 4242 4242 4242 4242, confirm funds and the app fee on the connected account, issue a refund from the connected account's Dashboard.

### 3.3 Effort (rough hours)
| # | Task | Hours |
|---|---|---|
| 1 | Connect state model + `connect.js` | 3–4 |
| 2 | Admin onboarding flow and status UI | 3–4 |
| 3 | Direct-charge Checkout, fail closed, fee cap | 2–3 |
| 4 | Connect webhook and event handling | 4–5 |
| 5 | Mock mode for connect | 2–3 |
| 6 | Tests (unit + HTTP) | 4–6 |
| 7 | Test-mode E2E with Stripe CLI and fixes | 3–4 |
| 8 | Docs/env/checklist, owner alert wording | 1–2 |
| 9 | Legal page wording edits (draft only; lawyer reviews) | 2 |
| | **Core total** | **~24–33 h** |
| 10 | Optional: admin refund action and `charge.refunded` status | +5 |

### 3.4 Sequence
1. User finishes the platform Stripe account and completes the Connect platform profile. In parallel, the user gives test keys via a secure form.
2. Confirm the recommended configuration in the Connect platform profile (VERIFY the Standard-equivalent controller properties).
3. Build items 1–3 and the mock path, with tests (items 5–6). This works without live Stripe.
4. Add the Connect webhook (item 4), then E2E in test mode (item 7).
5. Apply the fail-closed switch and update docs and legal wording (items 8–9). Lawyer reviews the wording.
6. Live pilot with one shop: owner onboards, a $1–$2 live test deposit if Stripe allows (VERIFY), then owner refunds it themselves to confirm the whole flow. Keep `LEAD_FEE_WAIVED=1`.
7. Later: admin refund tool, per-shop dashboard, multi-tenant.

### 3.5 Multi-tenant / deployment notes (app is single-tenant today)
- Today one deployment = one shop = one set of env/config + one JSON/Postgres `db`. A per-deploy connected account fits this model with no schema change.
- **Shared platform key:** every deployment would hold BuzzCall's platform secret key. That key can create accounts and act on all connected accounts via `Stripe-Account`. The same key is already used for subscription billing in each deploy.
  - Mitigate with a **restricted key** per deployment (permissions: Connect accounts and account links, Checkout sessions, and refunds if built), and rotate on shop offboarding.
  - Or keep Stripe operations in a single central service as the app goes multi-shop.
  - Source for restricted keys: https://docs.stripe.com/keys-best-practices (linked from Stripe's code samples; not fetched, VERIFY).
- **Webhooks:** one Connect endpoint per deployment URL means each gets all connected accounts' events. The `event.account` filter above is the defense. Alternatively, one central webhook that routes to shops.
- **Real multi-tenant later:** needs a shops table, number-to-shop routing (Twilio number → shop), per-shop config instead of global `env`, per-shop `connectAccount` and fee settings, per-shop subscription tie-in (`billing.shops` already hints at this), and Stripe calls always passing `stripeAccount`. Direct charges make the Stripe side easy, as it's just the header.
- Mock and test keys: Connect webhooks in a production Stripe app receive both live and test events, so check `livemode` (/connect/webhooks).

---

## 4. Legal / compliance questions (for a lawyer or accountant; not advice)

1. **Money transmission:** if funds go straight from the customer to the owner's Stripe account (direct charge) and BuzzCall only takes an application fee, does BuzzCall avoid money transmitter licensing in Georgia and other states? How does that change if BuzzCall ever held funds (destination charges, delayed transfers)?
   - Stripe says its own affiliate (SPC) provides regulated services and that Stripe holds money transmitter licenses (/connect/best-practices, https://stripe.com/legal/connect).
   - Does that cover the platform's position?
   - Does the FinCEN/state "payment processor" exemption analysis need a written opinion before multi-shop scale?
2. **Terms of service:**
   - What exact language is needed so shops accept the Stripe Connected Account Agreement, plus Stripe's privacy-policy disclosure (see Stripe's sample text)?
   - Do Terms §3 (application fee wording, "deducted … as a platform fee") and §5 need to say plainly that BuzzCall is not a party to the deposit, the shop is merchant of record, and BuzzCall holds no funds?
   - Is the indemnity in §5/§11 adequate?
3. **Refund and customer-facing disclosures:** `refunds.html` says "we ask for a deposit through Stripe." Should it name the shop as the seller and payee? Does it need to disclose the receiving business at payment time (Stripe Payments Terms §3.4/§3.7 require the user to clearly identify itself and a fair refund policy)? Does the "credited to final bill" language plus the trip-fee retention meet Georgia consumer rules and card network rules? The refund page is still a draft pending counsel review.
4. **Who answers customer complaints and chargebacks?** `refunds.html` tells customers to contact BuzzCall support if they can't reach the shop. Does acting as a relay create any duty or liability (and does BuzzCall issuing API refunds on the owner's behalf change it)?
5. **Tax:**
   - 1099-K: Stripe says it issues 1099-K forms for connected accounts that pay their own Stripe fees, and the platform doesn't (https://docs.stripe.com/connect/tax-reporting). The doc lists thresholds ($20,000 and 200 transactions). The accountant should confirm current federal and state thresholds.
   - BuzzCall's own income is the application fees and subscriptions. Is BuzzCall's reporting correct, and does Stripe issue BuzzCall its own 1099-K?
   - Sales tax on deposits is the owner's issue. Does BuzzCall's Terms need to say that?
6. **Entity and account:** does the Stripe account's legal name and EIN match the Georgia LLC (terms.html TODO)? Are there consequences of being wholly owned by Bytspot Inc. (beneficial ownership disclosures, who signs for Stripe)? Who owns the Connect platform account (LLC vs parent), and does Bytspot Inc.'s own Stripe account matter?
7. **Platform review and prohibited businesses:** which trades are acceptable under Stripe's prohibited and restricted businesses lists and Connect platform requirements? Does hair braiding, plumbing and HVAC pass? Is the platform use case approved as written?
8. **Data and privacy:** customer phone, name and need are shared with Stripe via Checkout metadata and the connected account. Update `privacy.html` and consent text (the SMS consent page is already separate).
9. **Insurance and liability caps:** consider an E&O or cyber policy, and a limitation of liability. §10 disclaimers exist but have not been reviewed.
10. **Pilot paperwork:** does the pilot agreement need a shop addendum covering Stripe onboarding, refund responsibility and fee deduction?

---

## 5. What the user must provide (secure forms only; never in chat or files)

1. **Stripe test-mode keys for the TryBuzzCall platform account first:**
   - Secret key (`sk_test_…`), or ideally a **restricted key** (`rk_test_…`) with only Connect account, account link, Checkout session and refund permissions.
   - Publishable key not needed (hosted Checkout).
2. **Webhook signing secrets:** the Connect endpoint secret (`whsec_…`, scope "Connected accounts") and the existing platform endpoint secret, test mode first. We can create the endpoints once the user confirms or does it in the Dashboard.
3. **Live keys later**, only after the platform profile is approved, and only for the pilot deployment.
4. **Connect `client_id` (`ca_…`)**: **not needed** for the recommended Account Links flow. Only needed if we choose OAuth to link owners' *existing* Stripe accounts.
5. **Decisions from the user:**
   - Standard-equivalent plus direct charges (yes/no).
   - Lead fee: keep waived in the pilot? Amount and cap later (see §2).
   - Do you want an in-app refund tool in the first release (+5 h)?
   - Whether to disable the current platform-charge fallback outright (recommended).
6. **From the Dashboard (user only):** finish the platform account activation and the Connect platform profile questionnaire, and complete the branding settings (name, icon, color).

---

## Sources
- https://docs.stripe.com/connect/accounts (account types, comparison table; marked deprecated for new platforms)
- https://docs.stripe.com/connect/migrate-to-controller-properties (Standard = controller defaults)
- https://docs.stripe.com/connect/accounts-v2
- https://docs.stripe.com/connect/charges (charge types, refunds, disputes)
- https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted (Stripe-Account header, application fee, refund_application_fee)
- https://docs.stripe.com/connect/direct-charges-fee-payer-behavior (fee and dispute-fee payer)
- https://docs.stripe.com/connect/best-practices (liability, KYC)
- https://docs.stripe.com/connect/design-an-integration, https://docs.stripe.com/connect/interactive-platform-guide
- https://docs.stripe.com/connect/standard-accounts (Account Links onboarding)
- https://docs.stripe.com/connect/webhooks
- https://docs.stripe.com/connect/manage-payout-schedule, https://docs.stripe.com/payouts
- https://docs.stripe.com/connect/tax-reporting (1099-K)
- https://docs.stripe.com/connect/updating-service-agreements (service agreement language)
- https://docs.stripe.com/connect/marketplace/essential-tasks (platform profile steps)
- https://docs.stripe.com/connect/top-ups (platform profile approval requires KYC)
- https://stripe.com/pricing, https://stripe.com/connect/pricing (fetched 2026-10-23)
- https://stripe.com/legal/connect (Stripe Services Agreement; refunds, disputes and fraud on the user)
- Third-party only (unverified): platform review timing of about 1–2 days (web search results for "Stripe Connect platform profile review", 2026-10-23).
