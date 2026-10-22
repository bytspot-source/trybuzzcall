# Pilot Checklist (14-day free pilot)

Applies to **Home Services** (plumbing/HVAC) and **Braiders**. A missed call is not SMS consent. This is a conservative implementation and operator-review checklist, **not a compliance certification**. Source integration and deployment behavior must be verified; a checked document is not carrier approval. See [SMS Operations](SMS_OPERATIONS.md) for the contract and [official sources](SMS_OPERATIONS.md#official-sources-and-external-review).

**No deployment, number purchase, carrier submission, or fee is authorized by this checklist.** Arrange separate approval for those actions. Keep `SMS_ENABLED` off until the reviewed launch gate below is satisfied.

## 1. Business identity, disclosure, and written evidence
- [ ] Shop signed the pilot agreement with actual business identity, owner contact, vertical, hours, and forwarding arrangement. A supplied number is contact data, not SMS permission.
- [ ] Counsel/operator reviewed the draft consent page, SMS Terms, and Privacy Policy for this business. No claim of certification, blanket consent, or guaranteed delivery is used.
- [ ] Collect affirmative written **client** opt-ins for `customer_service` and separate written **owner/staff** opt-ins for `owner_alerts`, including any billing/account alerts. Store actual evidence securely outside the app before recording grants.
- [ ] Disclosure identifies the business and sender, nonmarketing purposes, variable frequency, message/data rates, STOP/HELP, and consent not being a condition of purchase. A phone-call alternative is available.
- [ ] Record consent time, disclosure version, and a non-secret evidence reference. Do not place passwords, auth tokens, or evidence-access URLs in records. Do not solicit initial permission via unsolicited SMS.
- [ ] Confirm missed calls, inbound messages, START, payment, waitlist signup, and merely providing a number never create grants. Do not transfer consent between businesses or senders.

## 2. External customer registration and routing review
- [ ] Verify the actual customer's Twilio customer profile and brand identity; do not register all businesses under a blanket platform brand.
- [ ] Independently verify brand/campaign approval and campaign verification, approved use case, and sending-number association with the campaign/Messaging Service. Record the review reference without secrets; submitting registration alone is not approval.
- [ ] Review the actual E.164 sending number and opt-out configuration. Standard Twilio filtering is separate from Advanced Opt-Out, which is disabled by default; test whichever configuration is used. Do not invent a sender or claim carrier approval from passing tests.
- [ ] Verify public HTTPS URL, account identity, number routing, voice/status/SMS webhook URLs, and forwarding. All live Twilio requests require valid signatures and matching account/routing, including callbacks; test rejection of bad signatures, wrong accounts, wrong destinations, and mismatched public URLs.
- [ ] Verify `SKIP_TWILIO_VALIDATION` cannot bypass live checks. Unsigned local demo mode requires `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1`, no live credentials, and `NODE_ENV != production`; never expose that mode as a live endpoint.

## 3. Configuration and protected persistence
- [ ] Review `BUSINESS_NAME`, `VERTICAL`, `BUSINESS_VERTICAL`, `OWNER_PHONE`, `FORWARD_TO_PHONE`, booking settings, and a stable per-business slug in `SMS_CONSENT_BUSINESS_ID`. Set `TWILIO_PHONE_NUMBER` to the reviewed E.164 sender; leave `SMS_ENABLED` off for now.
- [ ] Review `LEAD_FEE`, `LEAD_FEE_WAIVED=1` during the free pilot, and any separately approved Stripe/Connect setup. Require `STRIPE_WEBHOOK_SECRET` and reject unsigned/invalid payment webhooks; only verified paid events confirm deposits. Do not perform live purchases or fees as a test; payment never grants SMS permission.
- [ ] Protect `DATA_DIR`, logs, backups, admin access, and actual written evidence. On Render, place `DATA_DIR` on a persistent disk. Review manual retention/deletion responsibilities; there is no automatic deletion schedule.
- [ ] Use authenticated `POST /api/consent` with JSON only and same-origin requests when an Origin header is present. Verify Basic admin authentication, rejection of unauthenticated requests and cross-origin writes, and authenticated `GET /api/consent` access.
- [ ] Record separate grants with `phone`, `purpose`, `consentedAt` (ISO timestamp), `disclosureVersion`, and `evidenceRef`; business and sender come from configuration, not request overrides. An evidence reference alone is not proof of written permission.

## 4. Local/staged acceptance tests (no live sends without separate approval)
- [ ] With SMS disabled, verify **all application SMS** are blocked, including confirmations, owner alerts, billing reminders, HELP, and inactive-service fallback. Provider-generated responses are separate.
- [ ] With the gate enabled only in an isolated no-live-credentials test setup, verify unconsented missed calls and inbound messages do not create grants or send application texts. Repeat for START, payment, waitlist signup, and providing a number.
- [ ] Verify wrong business, wrong sender, wrong purpose, missing evidence fields, and revoked grants cannot authorize a send. A client grant must not authorize owner alerts, or vice versa.
- [ ] After recorded test grants, verify Home Services and Braiders text-back/booking flows and owner notifications use their respective purposes. Voice fallback advises a caller to call again and never claims a text was sent.
- [ ] Test all supported STOP variations: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, and OPTOUT; include lowercase, whitespace/punctuation handling, and natural-language requests such as "please stop texting me", "opt out", and "please opt me out". Verify all purposes for that recipient are revoked locally.
- [ ] After opt-out, trigger future booking/deposit confirmations, payment events, owner alerts, billing reminders, HELP, and inactive-service messages; verify no application SMS bypasses the gate. Do not rely only on provider filtering.
- [ ] Verify provider `OptOutType` START/STOP/HELP events do not produce duplicate replies. Verify START only clears a delivery block and never restores grants. Repeat for UNSTOP and YES without provider metadata.
- [ ] Verify a fresh grant after opt-out requires fresh written evidence. If Twilio blocked the recipient, require their explicit provider opt-back-in first, then a fresh grant; reject attempts to bypass the provider block.
- [ ] Verify authenticated `action: revoke` for a phone revokes all purposes. Restart against the same protected `DATA_DIR`: grants, revocations, and blocked-send behavior must persist. Repeat the persistence check on the reviewed Render disk before live use.
- [ ] Simulate an opt-out write failure and a forced process exit in isolated test storage. Verify `smsSessionClean=false` survives the crash, all SMS/new grants remain blocked on restart, and suppression retries can persist. With `SMS_ENABLED=0`, reconcile missing opt-outs, then test authenticated `action: recover` with `acknowledgment: suppression_history_reviewed`; it must not restore revoked permissions. Verify recovery is rejected while SMS is enabled. Only one process may use a `DATA_DIR`.
- [ ] Run `node --test tests/consent-docs.test.js` and the source regression suite. Static document tests do not validate live Twilio behavior or legal sufficiency. Legacy demo scripts need manual consent setup or later updates and no longer text by default.

## 5. Reviewed launch gate and follow-up
- [ ] Document the reviewer, date, external approval references, written evidence custody, and runtime test results. Resolve any mismatch between source behavior and this contract before proceeding.
- [ ] **Enable `SMS_ENABLED` only after reviewed approval** of customer registration, campaign/sender association, disclosures/evidence, routing/signatures, persistence, and block tests, plus separate authorization for the live pilot. A configuration flag does not itself verify any of these.
- [ ] In the separately authorized deployment, verify HTTPS reachability and `/health`, then run only the approved, permissioned live smoke checks. Health status alone does not establish consent or carrier approval.
- [ ] Day 3: review permissioned missed-call recovery, blocked sends, help/opt-out handling, and owner callback speed without weakening the permission gate.
- [ ] Day 14: review leads, bookings, paid leads and fees, retained evidence/revocations, and any separately agreed plan conversion. SMS consent is not a condition of purchase and must not be inferred from choosing a paid plan.
