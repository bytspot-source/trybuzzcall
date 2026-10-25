# Admin workspace and payment pages

The private workspace at `/admin` uses the existing HTTP Basic authentication, login limits, and same-origin write protection. The redesign does not replace authentication, approve SMS consent, connect a payment provider, or deploy the service.

## Workspace

- **Overview:** counts calculated from stored conversations, bookings, deposits and pending setup requests. These are stored-record totals, not claims about today's revenue or net payouts.
- **Leads:** search the latest 100 displayed inquiries by name, phone or request; filter by conversation status. Pilot waitlist entries remain separate from shop customers.
- **Bookings:** search the latest 100 displayed bookings and filter confirmed appointments, unpaid holds, expired holds and payment conflicts.
- **Payments:** distinguish the BuzzCall subscription from customer deposits. Review invoices, lead fees, setup waivers and Stripe Connect readiness. Plan changes require a provider estimate and explicit confirmation; preview and mutation target the same subscription ID.
- **Operations:** inspect storage/fail-closed status, paused conversations, configured line behavior and the latest 50 owner notifications. Provider configuration is not proof of carrier approval or successful delivery.
- **Shop setup:** review submitted values and validation issues before applying them. Phone-routing changes retain the independent second confirmation. Only existing non-secret configuration fields are displayed.

Navigation, filtering and in-page billing feedback are progressively enhanced by `public/dashboard.js`. With JavaScript disabled, workspace sections remain readable, ordinary forms still submit, and Stripe's hosted billing portal remains available. In-page plan estimates require JavaScript.

## Payments and simulations

Live card entry and bank/identity onboarding remain on Stripe-hosted pages. BuzzCall does not collect card numbers, bank details or identity documents in these templates. Real payments still require the existing Stripe configuration, account readiness and valid webhooks; visual changes do not enable them.

- Missing Stripe keys and permitted demo mode show a clearly labeled simulation. Stripe test keys are labeled separately from live mode.
- `GET /pay/mock/:id` is read-only. It no longer marks a deposit paid. Completing a demo deposit requires a same-origin `POST` to that path. Expired or unavailable unpaid holds are rejected. Production demo restrictions remain in place.
- Browser mock-checkout completion redirects to a styled finished page. JSON clients retain their JSON response contract. Browser subscription cancellation/resumption and payment-method simulation return to Payments rather than showing raw JSON.
- `/payment/return` and `/billing/return` are read-only return pages. A query string never proves that payment succeeded or a booking/subscription is confirmed; these pages make that distinction explicit. Provider webhooks remain authoritative.
- Private workspace/billing pages and payment URLs use `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. Untrusted HTML is escaped, and invoice links are restricted to explicitly allowed HTTPS Stripe hosts.

## Maintenance and verification

Presentation lives in `src/ui.js`, `src/adminPages.js`, `src/paymentPages.js`, `src/setupPages.js`, `public/dashboard.css` and `public/dashboard.js`. Routes and existing payment logic remain in the server/billing/booking modules.

Run `npm test` after changes. The additional dashboard HTTP tests isolate credentials/data and block provider transport; the interaction tests exercise navigation, search, confirmations, duplicate clicks, failure/timeout feedback and plan-preview safety without a browser dependency. The optional Postgres integration suite requires its separately configured test database.

Before release, review the responsive layouts in an authenticated browser at desktop and phone widths, including keyboard navigation and reduced-motion preferences. No live payment, message or deployment is required for local UI verification. Mock examples must never be presented as real charges or customer records.
