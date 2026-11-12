# Go-live: deposits (direct charges on the shop's Stripe account)

The shop is the merchant of record for a customer deposit. Checkout is created on that shop's connected account. BuzzCall does not hold the money, does not transfer it, and does not claw it back. Refunds and disputes are handled in the shop's Stripe Dashboard. BuzzCall records them.

This is the cutover from Stripe **test** mode (`DEMO_MODE=1`) to live charges. It does not turn `DEMO_MODE` or any `AUTO_*` flag on or off, and it does not call Stripe for you. Dashboard steps at the bottom are owner-only. Before the first deploy of this model, follow `docs/CUTOVER_DIRECT_CHARGES.md` (expire open platform Checkout Sessions, and handle any old platform-held live deposits by hand).

Do this in order. Do not turn `DEMO_MODE` off, and do not put a live key in the environment, until the archive step has run.

## 1. Archive non-live deposits

Test-mode and mock deposit rows must not be released, refunded, or attached once the live key is in use. Each deposit stores `stripeMode` and `livemode`. The old release and refund functions still refuse a row whose mode does not match the key. In the default direct model those functions do not move money anyway.

On the admin Deposits page, check **Archive test and mock deposits** and submit **Archive non-live deposits**. The same action is `POST /admin/deposits/archive-non-live` with `confirm=1` (and `?shop=<id>` for a vendor line). Rows stay in the ledger with `archived: true`.

Live rows (`stripeMode` `live` and `livemode` true) are left alone.

## 2. Turn demo mode off

`DEMO_MODE=1` keeps unsigned mock webhooks and mock pay pages available in production. That is not acceptable next to a live secret key.

- Set `DEMO_MODE` empty (or `0`).
- The process **refuses to boot** if `NODE_ENV=production` (or Render), `DEMO_MODE=1`, and `STRIPE_SECRET_KEY` is `sk_live_` / `rk_live_`. A test key does not trip this check.

## 3. Secrets and config

| Variable | What |
| --- | --- |
| `STRIPE_SECRET_KEY` | Live restricted key (`rk_live_…`). Needs Checkout Sessions and PaymentIntents on connected accounts, Charges read, Accounts, and Account Links. Transfers are not used for deposits. Prefer a restricted key over `sk_live_`. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the **platform** endpoint (Your account). Subscriptions only. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the **Connected accounts** endpoint. This is the deposit endpoint. |
| `CONNECT_DASHBOARD` | `full` (default). Creates an Accounts v2 account (`POST /v2/core/accounts`) with `dashboard=full`, the shop paying Stripe's fees (`fees_collector=stripe`), and Stripe as the losses collector (`losses_collector=stripe`). The merchant `card_payments` capability is requested. `express` opts into the v2 form of a legacy Express account (`dashboard=express`, `fees_collector=application`, `losses_collector=application`, plus recipient `stripe_transfers`) and is not the pilot default. The choice is fixed when the account is created. |
| `DEPOSIT_MODEL` | `direct` (default). `platform_hold` keeps the old transfer code inert for tests. Product checkout does not use it. |
| `DEPOSIT_AMOUNT_MAX` | Pilot cap, default `50` dollars. A vendor cannot set a higher deposit. An admin can, with a second confirmation. |
| `DEPOSIT_APPLICATION_FEE_CENTS` | Default `0`. No application fee on the pilot deposit. |
| `DEPOSIT_DAILY_MAX_COUNT` / `DEPOSIT_DAILY_MAX_DOLLARS` | Default 30 checkouts and $1500 per shop per 24 hours. |
| `EIN_ENCRYPTION_KEY` | 16+ characters. Encrypts an EIN at rest until carrier registration. |
| `RESEND_API_KEY` | Shop owner email on a new-device sign-in and on Connect changes. Without it those notices are log lines only. |
| `ADMIN_ALERT_EMAIL` | Dispute, refund, account-change, and disconnect alerts. Phones in those alerts are masked. |

Leave `AUTO_ONBOARDING`, `AUTO_PROVISION_NUMBERS`, and `AUTO_A2P` as they are. `AUTO_SPEND_APPROVAL` defaults **on**.

## 4. Webhook events

Platform endpoint `{PUBLIC_BASE_URL}/stripe/webhook` (scope **Your account**). Deposit Checkout Sessions on this endpoint are ignored. Keep it for subscriptions:

- `checkout.session.completed` (subscription signup)
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `invoice.paid`
- `invoice.payment_failed`

Accounts v2 also sends **thin** events. Stripe delivers those on **Your account**, not on Connected accounts, even when the same v2 account also sends a v1 `account.updated` on Connected accounts. Add these to the platform endpoint above (`{PUBLIC_BASE_URL}/stripe/webhook`). The payload does not include the account; BuzzCall loads it with `GET /v2/core/accounts/:id`. The Stripe CLI cannot forward thin events (`stripe listen` is snapshot-only).

- `v2.core.account[requirements].updated`
- `v2.core.account[configuration.merchant].capability_status_updated`
- `v2.core.account[configuration.merchant].updated`
- `v2.core.account.updated`
- `v2.core.account[identity].updated`
- `v2.core.account[defaults].updated`
- `v2.core.account.closed`

Connected-account endpoint `{PUBLIC_BASE_URL}/stripe/connect/webhook` (scope **Connected accounts**):

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `radar.early_fraud_warning.created`
- `radar.early_fraud_warning.updated`
- `account.updated`
- `account.application.deauthorized`

A paid session is applied only when `event.account` is that shop's stored account, the session id matches the booking's `stripeSessionId`, `client_reference_id` matches the booking, and `amount_total` / `currency` match. Event ids are remembered so a replay does not apply twice. A rejected event is acknowledged and does not write a dedupe row, so a bad delivery changes no record.

`charge.refunded` and `charge.dispute.*` mirror status and alert. They do not reverse a transfer. `account.updated` with charges off or a `disabled_reason` pauses new deposits for that shop. `account.application.deauthorized` stops pay links, voids open Checkout Sessions, and alerts.

## 5. Before the first live deposit

- Linking starts from a signed-in vendor session (`POST /vendor/connect/onboard`) or the legacy admin. One Stripe account cannot be linked to two shops.
- New accounts need admin approval before a deposit link is created: the platform admin queue, `POST /admin/vendors/:id/connect/approve`, or `POST /admin/connect/approve` on the legacy line. Checkout also requires charges to be on and no disabled reason. For a v2 account, charges are on when `configuration.merchant.capabilities.card_payments.status` is `active`, and a disabling `status_details` code or a past-due requirement is stored as `disabledReason`. A v1 `account.updated` snapshot still uses `charges_enabled` and `requirements.disabled_reason`. Both shapes are stored as `chargesEnabled` and `disabledReason`.
- A later account change or disconnect emails the admin (and the shop owner, when Resend is set).
- YES/NO after the appointment is a reputation flag. "No problem" is not NO. BuzzCall does not pause or release money on that reply.

## 6. Owner-only Stripe Dashboard steps

These are not set by this app.

1. Finish the Connect platform profile and branding (name, icon, color) before the first Account Link.
2. Create the two webhook endpoints above and subscribe the event lists in section 4. Copy each signing secret into the environment. Do not subscribe the platform endpoint to connected-account charge events and expect BuzzCall to fulfill them.
3. Leave `CONNECT_DASHBOARD=full` unless you explicitly accept Express liability (platform pays Stripe fees and is responsible for negative balances). Stripe does not let you change `dashboard` after the account exists. Onboarding is an Accounts v2 Account Link (`POST /v2/core/account_links`, `use_case.type=account_onboarding`). An account created before this change still uses a v1 Account Link.
4. Radar for a full-dashboard account is the shop's Radar, not the platform's. Stripe's Radar for Connect table says the platform Connect page cannot configure Radar for accounts with the full Stripe Dashboard, and direct charges use the collecting account's rules. Platform Radar still covers BuzzCall's own subscription charges. Confirm in the Dashboard whether any "platform controls for direct charges" toggle applies to these accounts; the Radar settings page says that toggle is for accounts controlled solely by the platform.
5. Payout timing is the shop's. Stripe's default is a daily payout. For a full-dashboard account the shop manages its own bank account. The platform can schedule that account's payouts only after turning on Platform controls. This app does not set a payout delay. Confirm the delay you want in the shop's Dashboard (or in Platform controls, if you enable them) before the pilot takes a real card.
6. The shop refunds and responds to disputes in its own Dashboard. BuzzCall has no refund button that moves this money.
