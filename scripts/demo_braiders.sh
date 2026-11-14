#!/usr/bin/env bash
# Braider demo: missed call -> name -> style (+ size/length) -> preferred day -> pick start time -> mock $50 deposit -> owner buzz.
# Also runs a second caller who asks for a callback instead of booking.
# Needs a server running with VERTICAL=braiders, BOOKING_ENABLED=1, DEPOSIT_ENABLED=1 and no STRIPE_SECRET_KEY (mock pay link).
# If nothing is listening on BASE, this script starts a temporary braider server itself (demo env, Twilio/Stripe blanked
# so nothing is really sent) and stops it at the end. Only run one server against data/ at a time.
# Texts need SMS_ENABLED=1 and written permission recorded through the admin API; a call never creates it. The script
# records demo-only permission for its test numbers (ADMIN_PASSWORD is required for an already running server) and
# stops when SMS is off. A running server must allow local unsigned webhooks (ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1).
# Usage: bash scripts/demo_braiders.sh            (or BASE=http://localhost:3000 bash scripts/demo_braiders.sh)
set -e
cd "$(dirname "$0")/.."
PORT=${PORT:-3000}
BASE=${BASE:-http://localhost:$PORT}
LOG=data/sms.log
CALLER=${CALLER:-+14705550142}
CALLER2=${CALLER2:-+14705550177}
post(){ local from=$1 path=$2; shift 2; curl -s -X POST "$BASE$path" --data-urlencode "From=$from" "$@"; echo; }
START=$(wc -l < "$LOG" 2>/dev/null || echo 0)

SPAWNED=
if ! curl -s -m 2 "$BASE/health" >/dev/null; then
  ADMIN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(18).toString("hex"))')
  echo "== No server at $BASE - starting a temporary braider demo server on :$PORT"
  env PORT=$PORT PUBLIC_BASE_URL=$BASE VERTICAL=braiders BUSINESS_NAME="${BUSINESS_NAME:-Braids by Demo}" \
    SERVICES="${SERVICES:-Knotless braids:360,Box braids:300,Locs retwist:120,Twists:180}" \
    BUSINESS_HOURS=09:00-19:00 BUSINESS_DAYS=1,2,3,4,5,6 BOOKING_ENABLED=1 DEPOSIT_ENABLED=1 DEPOSIT_AMOUNT=50 \
    BOOKING_LINK="${BOOKING_LINK:-https://example.com/book-demo}" OWNER_PHONE=+14045550100 \
    SMS_ENABLED=1 SMS_CONSENT_BUSINESS_ID=braids-demo TWILIO_PHONE_NUMBER=+14705550100 ALLOW_UNSIGNED_TWILIO_WEBHOOKS=1 \
    ADMIN_PASSWORD="$ADMIN_PASSWORD" NODE_ENV=development \
    TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= STRIPE_SECRET_KEY= STRIPE_CONNECT_ACCOUNT_ID= OPENAI_API_KEY= \
    node src/server.js > /tmp/missedcall-braiders-demo.log 2>&1 &
  SPAWNED=$!
  trap '[ -n "$SPAWNED" ] && kill $SPAWNED 2>/dev/null' EXIT
  for i in $(seq 1 30); do curl -s -m 1 "$BASE/health" >/dev/null && break; sleep 0.2; done
fi
H=$(curl -s "$BASE/health"); echo "health: $H"
echo "$H" | grep -q '"vertical":"braiders"' || { echo "Server at $BASE is not VERTICAL=braiders. Stop it or set PORT/BASE to a braider server."; exit 1; }
echo "$H" | grep -q '"smsEnabled":true' || { echo "SMS is off at $BASE (SMS_ENABLED must be 1). Nothing would be texted; stopping."; exit 1; }
[ -n "$ADMIN_PASSWORD" ] || { echo "Set ADMIN_PASSWORD (the server's) so the demo can record demo-only written permission; stopping."; exit 1; }
CONSENTED_AT=$(node -e 'console.log(new Date(Date.now() - 60000).toISOString())')
# Demo-only written permission for test numbers, via the authenticated operator API (password read from stdin, not argv).
grant(){ local out; out=$(printf 'user = "demo:%s"\n' "$ADMIN_PASSWORD" | curl -s -K - -H "Origin: $BASE" -H 'Content-Type: application/json' -X POST "$BASE/api/consent" \
  -d "{\"action\":\"grant\",\"phone\":\"$1\",\"purpose\":\"${2:-customer_service}\",\"consentedAt\":\"$CONSENTED_AT\",\"disclosureVersion\":\"demo-v1\",\"evidenceRef\":\"demo-only-not-real-consent\"}")
  echo "$out" | grep -q '"ok":true' || { echo "Could not record demo permission for $1: $out"; exit 1; }; }
grant "$CALLER"; grant "$CALLER2"; grant "${OWNER_PHONE:-+14045550100}" owner_alerts

echo; echo "== A. BOOKING PATH ($CALLER)"
echo "-- 1. Missed call (no-answer)"; post $CALLER /twilio/voice/status --data-urlencode "DialCallStatus=no-answer"
sleep 0.3; echo "-- 2. Client: name";  post $CALLER /twilio/sms --data-urlencode "Body=Hey this is Tasha"
sleep 0.3; echo "-- 3. Client: style + size/length"; post $CALLER /twilio/sms --data-urlencode "Body=1, medium, mid-back"
sleep 0.3; echo "-- 4. Client: preferred day"; post $CALLER /twilio/sms --data-urlencode "Body=Saturday"
sleep 0.3; echo "-- 5. Client: picks time 1"; post $CALLER /twilio/sms --data-urlencode "Body=1"
sleep 0.3
URL=$(tail -n 5 "$LOG" | grep -o "$BASE/pay/mock/[a-f0-9]*" | tail -n1 || true)
if [ -n "$URL" ]; then echo "-- 6. Client pays mock deposit: $URL"; curl -s "$URL" | sed 's/<[^>]*>/ /g' | tr -s ' '; echo
else echo "-- 6. (no mock deposit link: deposit/booking disabled or Stripe live)"; fi

echo; echo "== B. CALLBACK PATH ($CALLER2) - same Saturday; the 6-hr knotless booking above blocks overlapping starts"
post $CALLER2 /twilio/voice/status --data-urlencode "DialCallStatus=no-answer"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=Keisha"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=locs retwist"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=saturday"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=call"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=tonight after 7"

echo; echo "== SMS log (this run):"; tail -n +$((START+1)) "$LOG"
