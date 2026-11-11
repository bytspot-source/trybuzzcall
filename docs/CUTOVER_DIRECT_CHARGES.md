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
