# Cutover: platform deposits to direct charges

Do this before deploying the direct-charge build. Do not merge from the pull request, and do not change `DEMO_MODE` or any `AUTO_*` flag as part of this checklist. BuzzCall does not call Stripe for you here. These steps are done in the Stripe Dashboard, or by the owner with a restricted key, on purpose.

After this build is deployed, `{PUBLIC_BASE_URL}/stripe/webhook` ignores payment-mode Checkout Sessions. A customer who still has an old platform pay link is charged on BuzzCall's account, and the booking is never confirmed.

## 1. Expire open platform Checkout Sessions

1. In the Stripe Dashboard, open Payments → Checkout sessions for the **platform** account (test mode first, then live when you cut over).
2. Find sessions that are still `open` and were created by BuzzCall for a deposit (payment mode, not a subscription). Those are the ones with no connected-account header.
3. Expire each open session before the deploy. A session that is already `complete` or `expired` can be left.
4. In BuzzCall, any booking that still has a `payUrl` and is not paid will not be confirmable from that old link after deploy. The customer needs a new link, and a new link is only created once that shop's connected account is approved.

## 2. Handle old platform-held deposits by hand

Direct mode does not release or refund any row. That includes deposits that were charged on the platform before this change (`releaseDeposit` returns `direct_model`, `refundDeposit` returns `vendor_dashboard`).

1. Confirm with the owner whether any **live** deposit was ever taken on the platform account. If the answer is no, record that and stop.
2. If any live charge is still sitting on the platform (held, scheduled, paused, or disputed in BuzzCall, or simply unrefunded in Stripe), refund or otherwise resolve it in the **platform** Stripe Dashboard. Do not expect the BuzzCall Refund or Release buttons to move that money.
3. Archive test and mock rows from the admin Deposits page (`docs/GO_LIVE_PAYMENTS.md`) so they are not mistaken for live balances.
4. Only then deploy. New deposits are direct charges on the shop's account and are refunded by the shop in its own Dashboard.

## 3. Accounts v2, before the first new connected account

New shops are created with Accounts v2 (`POST /v2/core/accounts`), not v1 `accounts.create`. The default is still a full Stripe Dashboard, the shop pays Stripe's fees, and Stripe is the losses collector. The create sends `identity.country` (default `US`, override `CONNECT_ACCOUNT_COUNTRY`) in that same request as the merchant configuration. `CONNECT_DASHBOARD` is unchanged. Do not turn on `DEMO_MODE` or any `AUTO_*` flag for this step.

1. In the Stripe Dashboard, open the **Your account** webhook that posts to `{PUBLIC_BASE_URL}/stripe/webhook` (test mode first). Add the thin events listed in `docs/GO_LIVE_PAYMENTS.md` section 4 (`v2.core.account[requirements].updated`, the merchant capability events, `v2.core.account.updated`, `v2.core.account.closed`, and the identity and defaults events). Stripe sends those on Your account. It still sends v1 `account.updated` on the **Connected accounts** endpoint, including for a v2 account. Leave `account.updated` and `account.application.deauthorized` on `{PUBLIC_BASE_URL}/stripe/connect/webhook`.
2. Thin events do not include the account body. No new signing secret is required if you add the events to the existing Your account endpoint. If you create a new endpoint instead, put its signing secret in `STRIPE_WEBHOOK_SECRET` only after the handler is deployed, and keep the previous secret until deliveries move.
3. The Stripe CLI cannot forward thin events. Confirm a test account with a Dashboard event delivery, or with the event destination's delivery log, after deploy. This checklist does not call Stripe.
