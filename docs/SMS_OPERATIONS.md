# SMS Operations — recorded permission

Applies to **Home Services** (plumbing/HVAC) and **Braiders** on `feat/recorded-sms-permission`. **A missed call is not SMS consent.** This is the conservative implementation contract for the branch, not a compliance certification, a legal opinion, or evidence of carrier approval. Verify runtime behavior and the deployed version against this contract before enabling a pilot. Public legal pages remain drafts pending counsel review.

No deployment, carrier submission, number purchase, fee, or live message is authorized by this document. Those actions need separate approval. Use the [Pilot Checklist](PILOT_CHECKLIST.md) to record the review.

## 1. Separate application controls from external approval

| Area | Application contract | External/operator responsibility |
| --- | --- | --- |
| Permission | Record scoped grants/revocations and check every application SMS | Collect actual written evidence, review disclosure and scope, retain proof securely |
| Business/sender | Bind permission to configured business, sender, and purpose | Verify the actual customer's identity, approved brand/campaign, and number association |
| Opt-out | Revoke all purposes locally; START cannot restore grants | Review Twilio filtering and recipient-initiated provider opt-back-in when blocked |
| Webhooks | Validate live signatures, account, and routing | Configure the exact public HTTPS URL, account, sender, and callback routes |
| Persistence | Store permission and suppression state under `DATA_DIR` | Protect files/logs/backups, attach persistent storage, test restarts, review retention |

The application does not certify the truth or legal sufficiency of an evidence reference, perform carrier approval, or replace legal review. A passing test, successful payment, health response, or enabled flag proves none of those external prerequisites.

## 2. Start with SMS disabled and identities fixed

- `SMS_ENABLED` defaults off. Leave it off during setup and external review. Every application SMS uses the central permission gate, including log-only sends, customer confirmations, deposit/payment messages, owner alerts, billing reminders, HELP replies, and inactive-service messages. Provider-generated filtering/help responses are outside that application gate.
- Set `SMS_CONSENT_BUSINESS_ID` to a stable per-business slug, not a display name that changes during rebranding. Set `TWILIO_PHONE_NUMBER` to the reviewed E.164 sending number. Keep the actual identity and routing consistent with registration.
- `customer_service` covers the disclosed nonmarketing client service/booking exchange. `owner_alerts` separately covers disclosed lead, booking, and billing/account alerts to owners or staff. One scope does not authorize the other, even for the same phone number.
- Business and sender are taken from configuration, not request-supplied overrides. Do not copy grants between businesses or senders; changed identities require reviewed new permission.
- Missed calls, inbound messages, START, payment, waitlist signup, and merely providing a number do not create grants. Never solicit initial opt-in by unsolicited SMS. Twilio's allowance for an exchange scoped to an incoming text is not recurring permission; BuzzCall deliberately requires recorded written permission even for that exchange.
- Voice fallback advises the caller to call again and never claims a text was sent. Automatic text-back is only for an already permissioned recipient. Consent is not a condition of purchase; a telephone alternative remains available.

## 3. Collect evidence before recording a grant

1. Review a business-specific written or electronic opt-in form outside the automated SMS flow. Identify the actual business and sending number, the message purpose, variable frequency, possible message/data rates, STOP/HELP instructions, and consent not being a condition of purchase. Include the reviewed Terms and Privacy links. Do not bundle client and owner permissions or preselect consent.
2. Obtain the recipient's affirmative written choice for the relevant purpose. Retain the actual disclosure and response, recipient identity, timestamp, and collection context in secured external evidence storage. An operator's assertion or a database row alone is not proof of the recipient's written permission.
3. Assign a non-secret internal evidence reference. Use a record identifier, not a URL, password, authentication token, access link, or copied private evidence. Limit access to the actual evidence to authorized personnel.
4. Use the authenticated operator API below to record the grant. The consent time must reflect when the recipient actually agreed, not a convenient new timestamp applied to old evidence. Keep the disclosure version traceable to the text presented to that recipient.
5. Review the stored record through authenticated `GET /api/consent`. Check phone, purpose, configured business/sender, consent time, disclosure version, and evidence reference without copying private records into tickets or logs. A successful write does not validate carrier approval or the evidence's legal sufficiency.

### Operator API contract

Both `GET /api/consent` (read) and `POST /api/consent` (write) require **Basic admin authentication**. Use an approved authenticated client over HTTPS for live administration; keep credentials out of command lines, URLs, documentation, and logs. This endpoint is not a public opt-in form.

Writes accept **JSON only** with `Content-Type: application/json`. If an `Origin` header is present, it must be **same-origin**; cross-origin writes must be rejected. Omitting Origin never bypasses authentication. The operator supplies the following fields for a grant, not a business or sender override:

| Field | Meaning |
| --- | --- |
| `action` | `grant` |
| `phone` | Recipient phone number in E.164 form |
| `purpose` | Exactly `customer_service` or `owner_alerts` |
| `consentedAt` | Actual consent time as an ISO timestamp |
| `disclosureVersion` | Identifier for the disclosure the recipient accepted |
| `evidenceRef` | Non-secret internal reference to secured actual written evidence; not a URL or token |

To revoke, send a JSON write with `action` set to `revoke` and `phone` set to the recipient. Revocation applies to all purposes for that recipient in the configured business/sender context. Do not edit stored JSON directly to erase suppression history. The API records permission; it does not bypass `SMS_ENABLED`, provider blocks, or sender registration.

## 4. Opt-out, HELP, and fresh permission

- Standard STOP keywords include STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, and OPTOUT. Natural-language requests such as "please stop texting me", "opt out", and "please opt me out" also revoke all purposes locally. Verify case, whitespace, punctuation, and the supported natural-language variations in the runtime tests; a keyword list is not permission to ignore a clear request.
- After revocation, block future application texts, including pending booking/deposit confirmations, owner alerts, billing reminders, and generic inactive-service replies. Payment or an existing appointment is not an exception. HELP responses generated by the application still pass the central gate; offer the existing support email/phone when SMS cannot be sent.
- Twilio's standard keyword filtering is separate from **Advanced Opt-Out, which is disabled by default**. Review the actual number/Messaging Service configuration; do not assume Advanced Opt-Out is active.
- When Twilio reports `OptOutType` START, STOP, or HELP, it has already sent the provider-managed reply. Process the state change as applicable without a duplicate application reply. Do not promise an extra application STOP confirmation once permission has been revoked.
- **START only clears a delivery block; it never restores grants.** The standard UNSTOP and YES opt-back-in keywords have the same limited behavior. If Twilio blocked delivery, the recipient must first explicitly opt back in with the provider. Then obtain fresh written evidence and record a fresh operator grant. If no provider block exists, a fresh grant still requires fresh written evidence after the opt-out. Never reuse old permission or change its timestamp to simulate renewed consent.

## 5. Signed live routing versus unsigned local simulation

Every live Twilio request requires a valid signature plus matching account and routing for the configured sender, including voice, status, and inbound SMS requests. Review `PUBLIC_BASE_URL` against the exact external webhook URL and test wrong-account, wrong-number, bad-signature, and mismatched-URL rejection. `SKIP_TWILIO_VALIDATION` no longer bypasses live checks.

The unsigned exception is only for a **local** demo: `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1`, no live credentials, and `NODE_ENV != production`. It never authorizes unsigned live traffic. Do not expose that mode through a public tunnel or use a production database. Local SMS simulations still require explicit gate configuration and recorded test grants; a logged message does not demonstrate real delivery.

The Stripe webhook independently requires `STRIPE_WEBHOOK_SECRET` and a valid signature; unsigned payment events are never trusted, even when no Stripe API key is configured. Only a verified `paid` payment event can confirm a deposit. Local simulations use the explicit mock payment/billing routes, not unsigned webhooks.

Existing `scripts/demo_simulate.sh`, `scripts/demo_braiders.sh`, and `scripts/demo_billing.sh` need manual consent setup or later updates. They no longer text by default, and the old transcripts or exit behavior are not guaranteed under the new authentication and permission rules. Do not fix a demo by weakening live validation or bypassing the gate.

## 6. Protected persistence and retention

Use a dedicated, access-restricted `DATA_DIR` for each business deployment. Permission records include recipient, business, sender, purpose, consent/recording timestamps, source, disclosure version, and evidence reference; revocation timestamps/source and delivery-block state must remain available to prevent unwanted sends. Keep the actual written evidence separately secured, and protect application logs and backups as well as the JSON store.

On Render, configure `DATA_DIR` on a **persistent disk**, not ephemeral application storage. Restart with the same directory and verify both active grants and revoked/blocked recipients retain their state. Repeat this check before the approved live pilot; an in-memory test alone is insufficient. If permission or suppression history is missing after a restore, keep SMS disabled and reconcile records before any send.

### Crash and storage-error recovery

Before accepting traffic, the process atomically persists `smsSessionClean=false`. A graceful SIGTERM/SIGINT shutdown drains requests and writes `smsSessionClean=true` only if permission persistence is healthy and no provider send remains pending. A disconnected HTTP client cannot hide pending provider work; that shutdown keeps the unclean marker and requires recovery. A forced exit, crash, or failed permission write leaves the marker unclean: the next process blocks all SMS and new grants until an operator completes recovery. Startup fails if the safety marker cannot be persisted. Run only one process per data directory; this JSON store has no multi-writer coordination.

Failed revocations remain suppressed in memory and can be retried (including the same MessageSid) after storage recovers. A duplicate retry persists the original suppression; it does not create a new grant. A crash before that retry can lose the unsaved event, so **never clear quarantine just to restart delivery**.

1. Keep or set `SMS_ENABLED=0`. If needed, restart with SMS off; restarting alone does not clear quarantine.
2. Review authenticated `GET /api/consent`, including `recoveryRequired` and `persistenceFailed`. Reconcile any missing opt-outs against provider delivery records and retained external evidence. Record missing suppressions through authenticated `action: revoke`; this remains available in quarantine. Keep evidence private.
3. Only after reconciliation, submit an authenticated, JSON-only, same-origin `POST /api/consent` with `action` set to `recover` and `acknowledgment` set to `suppression_history_reviewed`. Recovery is rejected while `SMS_ENABLED=1`. This persists retained suppressions and removes the recovery block; it grants no permission and clears no recipient-level revocation or provider block.
4. Verify denied recipients and restart persistence again before separately reviewed re-enablement. Do not edit or delete `smsSessionClean` or suppression records to bypass recovery. If shutdown cannot write the clean marker, recovery remains required after restart.

There is **no automatic retention-based deletion schedule** in the current implementation. Operators must review retention with the business and counsel and manually handle authorized deletion requests across records, logs, backups, and external evidence. Do not promise deletion within a fixed number of days or erase opt-out state in a way that resumes messages. Persistent storage is not, by itself, a security or encryption guarantee.

## 7. Validation and enablement

Run `node --test tests/consent-docs.test.js` for static documentation checks and the source regression suite for enforcement. These are separate: document tests do not validate signatures, actual evidence, carrier status, or legal sufficiency. In isolated local tests verify default-off blocking, separate scopes, no automatic grants, invalid consent writes, every outbound SMS path, STOP variations, no duplicate provider replies, fresh-grant requirements, and restart persistence.

Complete the [Pilot Checklist](PILOT_CHECKLIST.md). Enable `SMS_ENABLED` only after reviewed approval of the actual customer profile/brand, verified campaign and sender association, written evidence/disclosures, routing/signatures, protected persistence, and passing runtime checks. Separately authorize any live deployment or smoke messages; use only already permissioned recipients. Record reviewer/date and non-secret references to external approval and test results. Do not label this review as compliance certification.

## Official sources and external review

These official sources were supplied for the documentation review. They establish provider requirements, not an externally verified approval for any BuzzCall business. Confirm current provider requirements and actual customer status with the responsible reviewer before live use.

- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy), April 13, 2026 version: prior express consent and proof; written consent for downstream software customers; scoped inbound exchanges rather than general recurring permission; no transfer of consent.
- [A2P 10DLC onboarding for ISVs](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv): register actual customer identities, not all customers under a blanket platform brand.
- [A2P 10DLC quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart): verified campaign and associated sender; no unsolicited SMS to solicit initial opt-in.
- [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out): standard filtering versus optional Advanced Opt-Out, disabled by default; `OptOutType` means the provider has already replied.
