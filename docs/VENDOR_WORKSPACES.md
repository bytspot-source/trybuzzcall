# Platform admin and vendor workspaces

## Which screen is which?

| Route | Who can use it | Purpose |
| --- | --- | --- |
| `/admin` | Platform administrator, using the existing Basic admin credentials | Vendor roster, onboarding approvals, account invitations, access status, phone assignments, billing/payout summaries and platform storage health |
| `/vendor/login` | Individually invited business owner | Sign in with that vendor's email and password |
| `/vendor` | Signed-in business owner | Only that shop's call history, leads/customers, bookings, subscription, invoices and Stripe payout connection |
| `/vendor/settings` | Signed-in business owner | Own business name, hours, time zone, services, booking preferences and deposit settings |
| `/admin/legacy` | Platform administrator only | Existing single-business records and controls, kept separate from vendors |

The public website links to vendor sign-in. A vendor cookie does not authorize platform routes; platform Basic credentials do not sign someone into a vendor account. Vendor requests never select a store from a submitted `shopId`, email, subscription ID or URL parameter.

## Enroll a business

1. The business submits `/setup`, or the platform administrator creates a vendor from `/admin`.
2. For a submitted setup, review the owner email, contact numbers, hours, services and deposit settings; check the approval confirmation before approving. Approval creates a separate store and account, not a migration of legacy data.
3. The private admin response displays a one-use activation code, valid for 24 hours. Share it privately with the verified owner. **No invitation email is sent automatically.** Do not put codes in tickets, chat transcripts, logs, screenshots or URLs.
4. The owner enters the code at `/vendor/activate`, chooses a 16–128 character password, then signs in separately.
5. In the platform vendor detail, assign a Twilio number already provisioned for this platform. The assignment must be unique and requires explicit confirmation. Set/confirm owner-alert and forwarding destinations on the same page. Creating an account does not buy a number or configure carrier routing.
6. The owner can review subscription checkout and connect their own Stripe account. Live card entry and identity/banking collection remain on Stripe. Braider pilot subscriptions remain inquiry-only until their terms/pricing are confirmed; the home-services subscription cannot be automatically applied to them.

Founding setup-fee waivers are allocated across the platform at approval/creation, counting retained legacy founding shops and existing vendor allocations against `FOUNDING_SHOPS_LIMIT`. They are not independently reset for every vendor. A failed provisioning can be retried by the administrator using the same email without creating another identity or store.

Suspending a vendor revokes all its sessions and blocks new vendor logins and incoming automated call/SMS processing. Restoring active status requires a fresh login. Issuing a new activation code invalidates the previous password, invitation and sessions. It does not send a password or expose the existing hash. Signed payment events for suspended shops can still reconcile actual payments; suspended shops do not send SMS from those events.

## Isolation and persistence

- Platform identity records contain salted scrypt password hashes, hashed invitation/session tokens, explicit shop IDs and account versions. Raw passwords and tokens are not stored.
- Sessions expire after 12 hours and are revocable. Cookies are `HttpOnly`, `SameSite=Lax`, scoped to `/vendor`, and `Secure` in production. Lax permits Stripe's top-level return navigation; every vendor mutation additionally verifies the same origin, including its protocol.
- Each vendor has a private file directory `DATA_DIR/shops/<id>/` and separate Postgres keys `shop:<id>:db` and `shop:<id>:config`. Vendor stores share a bounded database pool. Spill records and SMS logs are also separated. Existing legacy files/keys remain unchanged.
- Asynchronous work carries explicit shop context. It does not swap shared globals. Business configuration, callers' opt-outs, owner contacts, bookings, billing records and Stripe Connect IDs resolve inside that context. Missing vendor values never inherit legacy owner or business configuration.
- Slot calculations use each shop's IANA time zone, including daylight-saving transitions, without changing process-wide `TZ`. Call-history timestamps are explicitly displayed in UTC.
- Vendor settings cannot change phone destinations, provider identifiers, credentials, subscription prices or administrative fee settings. Phone changes belong to the platform administrator and require a second confirmation.
- Store failures block identity changes and tenant work rather than silently using another store. Graceful shutdown drains requests, flushes vendor and platform state, and reports a non-clean exit if draining/flushing fails.

## Provider routing and payments

Twilio signatures are verified before selecting a shop. Assigned `To` numbers choose the initial call/SMS destination; signed voice callbacks additionally need a previously recorded parent `CallSid` and caller. Unknown, ambiguous, suspended or reassigned routes do not fall back to another business. Replayed final call results do not generate additional text-backs. At most 500 call records per vendor are retained; the latest 100 are displayed.

Stripe events are verified using the existing endpoint secrets. Connect deposits must match the receiving connected account and its own stored booking. Platform-account events cannot mark vendor deposits paid. Existing legacy platform deposits require their original stored checkout session and booking to match. Conflicting ownership is ignored; temporarily unbound initial billing events are retried while checkout ownership is being established. Verified subscription metadata can route early invoice events before other checkout events arrive.

Subscription operations select only records in the authenticated vendor's store. Plan changes remain preview-before-confirm. Checkout retries reuse matching, durable attempts with the same Stripe idempotency key; changing plans while another checkout is open is rejected rather than silently returning the wrong checkout. Active subscriptions prevent a second signup. Failed Stripe retrieval does not replace a confirmed subscription with an older webhook snapshot. Webhook completion is recorded only after successful work, and incomplete setup-fee creation can resume using the existing idempotency key.

Public `/api/checkout` remains available only for the retained single-shop mode while there are no vendors. Once vendors exist, it directs the user to sign in; vendor checkout uses `/vendor/billing/checkout`. Private pages and payment URLs are not cacheable and do not send referrers. Return query strings never prove payment or activation.

## Operating limits and release checks

- **Use one application instance and one Node worker.** The underlying JSON-document persistence has a process-local cache; this change does not provide multi-instance concurrency or database row-level security. Do not scale it behind multiple writers without changing that storage architecture.
- No automatic legacy migration, cross-vendor account membership, invitation-email service, or SMS retry queue is included. Existing records stay with the platform until a separately reviewed migration assigns them.
- These account/role changes do not establish customer SMS permission or carrier approval. Review the separate recorded-consent work and existing SMS operations checklist before enabling real messaging. Do not treat an invitation, login, phone assignment or payment as SMS consent.
- No real accounts, charges, messages or deployments are created by the tests. Do not put real invitation codes or session cookies in design previews.
- Run `npm test`, including the tenant storage, payments, HTTP isolation and shutdown suites. The optional real Postgres test needs `TEST_DATABASE_URL`; the normal suite uses file storage and the declared in-memory Postgres test dependency.
- Before release, visually review both roles in an authenticated browser on desktop/mobile, perform a two-vendor smoke test against the intended test database and provider test mode, and verify Stripe returns/webhook configuration. Unit tests are not a production certification.
