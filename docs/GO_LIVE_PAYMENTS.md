# Go-live: deposits (separate charges and transfers)

Bytspot is the merchant of record. Customer deposits land on the platform Stripe account and are transferred to the shop after the job. This is the cutover from today's Stripe **test** mode (`DEMO_MODE=1`) to live charges. It does not change the charge model and it does not touch Stripe Dashboard settings you still have to set by hand (Radar rules, the webhook endpoint itself, payout delay, the losses-collector request).

Do this in order. Do not turn `DEMO_MODE` off, and do not put a live key in the environment, until the archive step has run.

## 1. Archive non-live deposits

Test-mode and mock deposit rows must not be released, refunded, or attached to a connected account once the live key is in use. Each deposit stores `stripeMode` and `livemode`. Release, refund, and attach refuse a row whose mode does not match the key.

On the admin Deposits page, check **Archive test and mock deposits** and submit **Archive non-live deposits**. The same action is `POST /admin/deposits/archive-non-live` with `confirm=1` (and `?shop=<id>` for a vendor line). Rows stay in the ledger with `archived: true`. They are skipped by the release job.

Live rows (`stripeMode` `live` and `livemode` true) are left alone.

## 2. Turn demo mode off

`DEMO_MODE=1` keeps unsigned mock webhooks and mock pay pages available in production. That is not acceptable next to a live secret key.

- Set `DEMO_MODE` empty (or `0`).
- The process **refuses to boot** if `NODE_ENV=production` (or Render), `DEMO_MODE=1`, and `STRIPE_SECRET_KEY` is `sk_live_` / `rk_live_`. A test key does not trip this check.

## 3. Secrets to set

| Variable | What |
| --- | --- |
| `STRIPE_SECRET_KEY` | Live restricted key (`rk_live_…`) with Checkout, PaymentIntents, Charges, Refunds, Transfers, and Connect reads/writes you actually use. Prefer a restricted key over `sk_live_`. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the **platform** endpoint (Your account). |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the **Connected accounts** endpoint. |
| `EIN_ENCRYPTION_KEY` | 16+ characters. Encrypts an EIN at rest until carrier registration. If unset, the app generates a key and stores it in the platform database; set one so a new disk does not orphan ciphertext. |
| `RESEND_API_KEY` | So the shop owner is emailed on a new-device sign-in and on Connect changes. Without it those notices are log lines only. |
| `ADMIN_ALERT_EMAIL` | Where dispute, fraud-warning, payout-failed, and new-Connect alerts go. |

Leave `AUTO_ONBOARDING`, `AUTO_PROVISION_NUMBERS`, and `AUTO_A2P` off until `docs/GO_LIVE_ONBOARDING.md` says otherwise. `AUTO_SPEND_APPROVAL` defaults **on**: even after those flags are on, an admin must approve number purchase and A2P submission per shop.

## 4. Webhook events the platform endpoint must subscribe to

Update the Stripe endpoint that posts to `{PUBLIC_BASE_URL}/stripe/webhook` (account scope: **Your account**) so it includes:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`
- `charge.refund.updated`
- `charge.dispute.created`
- `charge.dispute.closed`
- `radar.early_fraud_warning.created`
- `payout.failed`
- `transfer.created`
- `transfer.reversed`

Connected-account endpoint (`/stripe/connect/webhook`) stays: `account.updated`, `account.application.deauthorized`.

A paid Checkout Session is applied only when `metadata.shopId` routes to that shop (or the legacy line has no shop id), `metadata.bookingId` matches `client_reference_id`, the booking's stored `stripeSessionId` is the session id, and `amount_total` / `currency` match the booking. Anything else is acknowledged and ignored.

Charge, dispute, refund, and early-fraud events are routed with the platform PaymentIntent/charge index written at payment time. Subscribe to those events or a vendor-shop refund/dispute is dropped.

## 5. After the first live payment

- New Connect accounts do not receive pending deposits until an admin approves payouts (`POST /admin/connect/approve` on the legacy line, or `POST /admin/vendors/:id/connect/approve`).
- A shop's first `NEW_VENDOR_HOLD_JOBS` deposits (default 5) wait `NEW_VENDOR_HOLD_DAYS` (default 7) instead of 24 hours. **Release now** on a paused or disputed row asks you to confirm, and that confirmation also overrides the new-vendor hold.
- Vendor-set deposit amounts cannot go above `DEPOSIT_AMOUNT_MAX` (default $150). Raising it is the admin deposit-amount action.
- Card disputes show on `/admin/deposits`. A dispute before release pauses the payout. A dispute after release reverses the transfer or records vendor debt. An early fraud warning refunds and holds.
