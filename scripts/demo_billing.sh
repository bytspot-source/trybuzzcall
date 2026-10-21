#!/usr/bin/env bash
# Shop subscription demo in MOCK mode (no Stripe key). Starts its own temporary server on DEMO_PORT (default 3077) with a
# throwaway DATA_DIR, so data/ and the server on :3000 are untouched; Twilio/Stripe are blanked, nothing is sent or charged.
#  A. Setup fee ($99 estimate): founding shops #1-#10 waived; shop #11 monthly pays $49+$99 on its first invoice AFTER the
#     trial; shop #12 cancels during the trial (pending setup item voided, $0); shop #13 annual (waived).
#  B. Lifecycle on shop #11: trial_will_end buzz -> paid -> payment fails (past_due, service off) -> card updated ->
#     plan change preview + switch to annual (proration) -> cancel at period end -> canceled.
# Usage: bash scripts/demo_billing.sh
set -e
cd "$(dirname "$0")/.."
DEMO_PORT=${DEMO_PORT:-3077}
BASE=http://localhost:$DEMO_PORT
DATA=${DEMO_DATA_DIR:-$(mktemp -d /tmp/buzzcall-billing-demo.XXXX)}
AUTH="demo:demo-pass"

env PORT=$DEMO_PORT PUBLIC_BASE_URL=$BASE DATA_DIR="$DATA" ADMIN_PASSWORD=demo-pass VERTICAL=home_services \
  BUSINESS_NAME="Peach State Plumbing" OWNER_PHONE=+14045550100 BOOKING_ENABLED=1 DEPOSIT_ENABLED=1 \
  TRIAL_DAYS=${TRIAL_DAYS:-14} FOUNDING_SHOPS_LIMIT=${FOUNDING_SHOPS_LIMIT:-10} SETUP_FEE_WAIVED=0 SETUP_WAIVER_CODE= \
  BILLING_ENFORCE=1 PAST_DUE_GRACE_DAYS=0 INACTIVE_MODE=generic \
  TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_PHONE_NUMBER= STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET= STRIPE_CONNECT_ACCOUNT_ID= OPENAI_API_KEY= \
  node src/server.js > "$DATA/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -m 1 "$BASE/health" >/dev/null && break; sleep 0.2; done

J(){ node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));$1"; }
status(){ curl -s -u $AUTH "$BASE/billing/status"; }
signup(){ # plan -> prints sub id
  local url; url=$(curl -s -X POST "$BASE/api/checkout" -d plan=$1 | J 'console.log(j.url)')
  curl -s -X POST "$BASE/billing/mock/checkout/${url##*/}/complete" | J 'console.log(j.subscription.id)'; }
shop(){ status | J "const h=j.shops.find(s=>s.subscription==='$1'), inv=j.invoices.filter(i=>i.subscription==='$1');
  console.log('   shop #'+h.n+' '+h.plan+' status='+h.status+(h.cancel_at_period_end?' (cancels at trial/period end)':'')+(h.founding?' FOUNDING':'')+' setup='+h.setup.status+(h.setup.amount!=null?' \$'+h.setup.amount:'')+' ('+h.setup.reason+')');
  for (const i of inv.slice(0,${2:-1})) console.log('     invoice \$'+i.amount_due+' '+i.status+' ['+i.reason+']: '+i.lines.map(l=>l.description+' \$'+l.amount).join(' + '));"; }
state(){ status | J 'const s=j.subscription||{},d=v=>v?v.slice(0,10):"-";
  console.log(`   STATE [clock ${d(j.now)}] primary=${s.id} status=${s.status} plan=${s.plan} period_end=${d(s.current_period_end)} cancel_at_period_end=${!!s.cancel_at_period_end} service=${j.access.active?"ACTIVE":"INACTIVE"} (${j.access.reason}) credit=$${j.mockCreditBalance}`)'; }
adv(){ curl -s -u $AUTH -X POST "$BASE/billing/mock/advance" -d "days=$1" >/dev/null; }
api(){ curl -s -u $AUTH -X POST "$BASE$1" "${@:2}"; }
missed(){ curl -s -X POST "$BASE/twilio/voice/status" --data-urlencode "From=$1" --data-urlencode "DialCallStatus=no-answer" >/dev/null; sleep 0.2; tail -n1 "$DATA/sms.log" | sed 's/^.*SMS -> /   SMS -> /'; }

echo "== A. SETUP FEE"
echo "-- Shop #1 signs up (monthly): mock checkout page says:"
URL=$(curl -s -X POST "$BASE/api/checkout" -d plan=monthly | J 'console.log(j.url)')
curl -s "$URL" | sed 's/<[^>]*>/ /g' | tr -s ' \n' ' ' | sed 's/^ *MOCK checkout //' | cut -c1-260 | sed 's/^/   /'; echo
S1=$(curl -s -X POST "$BASE/billing/mock/checkout/${URL##*/}/complete" | J 'console.log(j.subscription.id)'); shop $S1
echo "-- Shops #2-#10 sign up (monthly, founding)"; for i in $(seq 2 10); do signup monthly >/dev/null; done
status | J 'console.log("   founding slots taken: "+j.founding.taken+"/"+j.founding.limit)'
echo "-- Shop #11 signs up (monthly): checkout page says:"
URL=$(curl -s -X POST "$BASE/api/checkout" -d plan=monthly | J 'console.log(j.url)')
curl -s "$URL" | sed 's/<[^>]*>/ /g' | tr -s ' \n' ' ' | grep -o 'One-time setup[^.]*\.[^.]*\.' | sed 's/^/   /'
S11=$(curl -s -X POST "$BASE/billing/mock/checkout/${URL##*/}/complete" | J 'console.log(j.subscription.id)'); shop $S11
echo "-- Shop #12 signs up (monthly), then cancels during the trial"; S12=$(signup monthly); shop $S12
api /api/billing/cancel -d sub=$S12 >/dev/null; shop $S12
echo "-- Shop #13 signs up (annual)"; S13=$(signup annual); shop $S13

echo; echo "-- +11 days: trial_will_end (owner reminder for shop #11 mentions the setup fee)"; adv 11
grep -- "-> +14045550100" "$DATA/sms.log" | grep "trial ends" | grep "setup" | head -1 | sed 's/^.*SMS -> /   SMS -> /'
grep -- "-> +14045550100" "$DATA/sms.log" | grep "trial ends" | grep -v "setup" | head -1 | sed 's/^.*SMS -> /   SMS -> /'
echo "-- +3 days: trials end -> first paid invoices"
adv 3
for S in $S1 $S11 $S12 $S13; do shop $S; done
status | J 'console.log("   founding slots taken: "+j.founding.taken+"/"+j.founding.limit)'

echo; echo "== B. LIFECYCLE (shop #11 as this deploy's shop)"
api /billing/mock/primary -d sub=$S11 >/dev/null; state
echo "-- next renewal fails: fail-next + advance 1 month -> invoice.payment_failed, past_due, owner buzz"
api /billing/mock/fail-next -d sub=$S11 -d on=1 >/dev/null; adv 31; state
grep -- "-> +14045550100" "$DATA/sms.log" | grep "didn't go through" | tail -1 | sed 's/^.*SMS -> /   SMS -> /'
echo "   missed call while past_due:"; missed +14705550198
echo "-- owner updates card in the mock portal -> open invoice paid"; api /billing/mock/update-card -d sub=$S11 >/dev/null; state; shop $S11
echo "-- +10 days, preview monthly -> annual"; adv 10
api /api/billing/preview -d sub=$S11 -d plan=annual | J 'console.log("   PREVIEW "+JSON.stringify(j))'
echo "-- switch to annual (always_invoice)"; api /api/billing/change-plan -d sub=$S11 -d plan=annual >/dev/null; state; shop $S11
echo "-- cancel at period end; +30 days still active; then past period end -> canceled"
api /api/billing/cancel -d sub=$S11 >/dev/null; adv 30; state; adv 340; state
echo "   missed call after cancel:"; missed +14705550197

echo; echo "(demo data: $DATA)"
