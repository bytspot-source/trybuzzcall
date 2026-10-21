# Pilot Checklist (14-day free pilot)
- [ ] Shop signed pilot agreement (name, owner cell, vertical, hours)
- [ ] Twilio GA number bought; A2P 10DLC brand + campaign approved
- [ ] `.env` filled: BUSINESS_NAME, BUSINESS_VERTICAL, OWNER_PHONE, FORWARD_TO_PHONE; LEAD_FEE, LEAD_FEE_WAIVED=1 during the free pilot (fees are recorded as `waived`, nothing charged) and STRIPE_CONNECT_ACCOUNT_ID if the shop has a connected Stripe account
- [ ] Deployed and reachable over HTTPS; Twilio webhooks set; `/health` OK
- [ ] Carrier no-answer forwarding set (or the shop uses the new number)
- [ ] Test: call, let it ring out, reply to texts, owner gets the BUZZ
- [ ] Owner approves text-back wording
- [ ] Day 3 check-in: missed calls caught, owner callback speed
- [ ] Day 14 review: leads recovered, jobs booked, $ value, paid leads + lead-fee total (admin page), convert to base plan (monthly, or annual with setup waived)
