# Go-live: self-serve onboarding

All three flags ship **off**. Deploy this build first and confirm a setup still waits for an admin. Then enable one flag at a time. Do not turn on number purchase or carrier registration until the steps under that flag are done in Twilio and Stripe. Those calls spend money.

## Order

1. **Deploy with every `AUTO_*` flag unset.** `POST /setup` still says the shop will be reviewed within 1 business day. Approving a pending setup in `/admin` still creates the vendor and shows an activation code. Resend is still optional: without `RESEND_API_KEY` no email is sent, and the signup is still saved.

2. **Stripe, test mode first.** Create the $49/month price (and the annual price if you want it). Set `STRIPE_PRICE_ID_BASE_MONTHLY`, `TRIAL_DAYS=14`, `STRIPE_SECRET_KEY` (`sk_test_...`), and `STRIPE_WEBHOOK_SECRET`. Point the platform webhook at `{PUBLIC_BASE_URL}/stripe/webhook`. Have one vendor start the trial from the checklist and confirm the subscription lands as `trialing` with a card. Live keys come after that, not before.

3. **Twilio account, still with the buy and A2P flags off.** The account needs a funded balance (keep it above `AUTO_PROVISION_MIN_BALANCE`, default $20). In Trust Hub, BuzzCall's primary customer profile must already be approved. Copy its `BU...` SID into `TWILIO_PRIMARY_PROFILE_SID`. `PUBLIC_BASE_URL` must be the https origin Twilio will call. Voice on a number is `POST {PUBLIC_BASE_URL}/twilio/voice`. Messaging is `POST {PUBLIC_BASE_URL}/twilio/sms`.

4. **Resend (welcome email).** Verify `trybuzzcall.com` and set `RESEND_API_KEY` if the new shop should get "your shop is ready". Without the key the account is still created; the log says the welcome was skipped. The admin alert uses the same key.

5. **`AUTO_ONBOARDING=1` only.** A shop verifies the alert cell, sets a password, and sees the checklist. The number and registration steps say **pending admin**. Customer text-backs for that shop wait until you record the carrier result in `/admin/onboarding` (or until step 7 approves them). Owner buzzes still send. Watch the queue for duplicate phones, duplicate emails, and name mismatches.

6. **`AUTO_PROVISION_NUMBERS=1`.** Leave the cap at 25 (`AUTO_PROVISION_MAX_PER_DAY`) until a few real shops have numbers. The buy runs only after the trial is `trialing` or `active`, once per shop. It tries the shop's area code, then the same state, then any US local, and sets that number's voice and SMS webhooks to this app. If the balance is under the floor, or the cap is used up, the shop is queued and nothing is bought. The checklist then shows the no-answer forwarding codes for Verizon, AT&T, and T-Mobile, and the option to list the number on Google.

7. **`AUTO_A2P=1` last.** This submits a real brand and campaign and is the step that costs about $21 the first month per shop. The shop picks a business type in the portal. LLC, corporation, and partnership require a 9-digit EIN and are Low-Volume Standard brands (`BrandType=STANDARD`, `SkipAutomaticSecVet=true`, campaign use case `LOW_VOLUME`). Their Trust Hub `business_type` is `Limited Liability Corporation`, `Corporation`, or `Partnership`, and `company_type` is `private`. Nonprofit is `business_type` `Non-profit Corporation`, `company_type` `non-profit`, and industry `NOT_FOR_PROFIT`. Sole proprietor uses the Sole Proprietor flow (`BrandType=SOLE_PROPRIETOR`, use case `SOLE_PROPRIETOR`) and does not need an EIN. A registration saved before this question existed has no type: it is flagged "needs business type" and is not submitted until you set one in `/admin/onboarding`. The owner of a sole proprietor brand must answer the one-time text Twilio sends to their cell (it cannot be a Twilio number, and the same mobile can only be used a few times). The poller runs every 15 minutes and whenever the shop or the queue is opened. It will not create a second brand or campaign for the same shop. Status is pending, in review, approved, or rejected with the carrier's reason. Customer text-backs stay held until approved.

## What you do in each dashboard

**Twilio**

- Primary Trust Hub profile approved, SID saved in `TWILIO_PRIMARY_PROFILE_SID`.
- Account balance above the floor. A local number is about $1.15/month.
- A2P: the app follows Twilio's ISV API, not the console wizard. Docs used for this build:
  - [Business information to collect](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info) — `business_type` is `Corporation`, `Limited Liability Corporation`, `Partnership`, or `Non-profit Corporation`. `company_type` is `private`, `public`, `non-profit`, or `government`. This app sends `private` for LLC, corporation, and partnership, and `non-profit` for a nonprofit.
  - [Nonprofit and government registration](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-for-government-and-non-profit-agencies) — a nonprofit's `business_type` is `Non-profit Corporation`, `company_type` is `non-profit`, and `business_industry` is `NOT_FOR_PROFIT`.
  - [Standard and Low-Volume Standard brand (ISV)](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api) — secondary profile policy `RNdfbf3fae0e1107f8aded0e7cead80bf5`, A2P trust product `RNb0d4771c2c98518d916a3d4cd70a8f8b`, then `SkipAutomaticSecVet=true` for low volume.
  - [Sole Proprietor brand (ISV)](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new) — starter profile `RN806dd6cd175f314e1f96a9727ee271f4`, sole-prop trust product `RN670d5d2e282a6130ae063b234b6019c8`, OTP via `POST /v1/a2p/BrandRegistrations/{Sid}/SmsOtp`.
  - [BrandRegistrations](https://www.twilio.com/docs/messaging/api/brand-registration-resource) and [UsAppToPerson campaigns](https://www.twilio.com/docs/messaging/api/usapptoperson-resource). Campaign status `PENDING` / `IN_PROGRESS` / `VERIFIED` / `FAILED` is what the poller reads.
  - [IncomingPhoneNumber purchase](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource) for the local number (`VoiceUrl`, `SmsUrl`).
- Published fees (they change; check the [brand comparison](https://help.twilio.com/articles/4407882914971-Comparison-between-Sole-Proprietor-Low-Volume-Standard-and-Standard-registration-for-A2P-10DLC)): about $4 brand + $15 campaign vetting + $1.50/month low-volume campaign. First month is about $20.50 before the number, in line with the $21 planning estimate. Sole proprietor campaigns are listed at about $2/month instead of $1.50.

**Stripe**

- Test-mode checkout from `/vendor/billing/checkout` with a 14-day trial and a card.
- Webhook secret set. Connect (deposits) stays a separate later step; onboarding does not start a Connect account.

**Resend**

- Domain verified, or accept that welcome mail is skipped.

## After the first real shop

Open `/admin/onboarding`. You want verified, trial, number purchased, registration approved, and no attention flag. Call the new number, let it forward, press 1, and confirm the caller text arrives only after approval while the owner buzz arrived immediately.
