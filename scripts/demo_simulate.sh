#!/usr/bin/env bash
# Simulates missed call -> caller replies -> booking + mock deposit -> owner buzz against a running server.
# With no Twilio/Stripe keys, all SMS go to console + data/sms.log and deposits use the local /pay/mock/:id link.
# Booking path needs the server started with BOOKING_ENABLED=1 DEPOSIT_ENABLED=1 (see .env.example);
# with booking off, step 4 falls through to the classic callback-window flow.
# Usage: npm start (in another terminal), then: bash scripts/demo_simulate.sh
set -e
BASE=${BASE:-http://localhost:${PORT:-3000}}
LOG="$(dirname "$0")/../data/sms.log"
CALLER=${CALLER:-+14705550123}
CALLER2=${CALLER2:-+14705550188}
post(){ local from=$1 path=$2; shift 2; curl -s -X POST "$BASE$path" --data-urlencode "From=$from" "$@"; echo; }
START=$(wc -l < "$LOG" 2>/dev/null || echo 0)

echo "== A. BOOKING PATH ($CALLER)"
echo "-- 1. Missed call (no-answer)"; post $CALLER /twilio/voice/status --data-urlencode "DialCallStatus=no-answer"
sleep 0.3; echo "-- 2. Caller: name"; post $CALLER /twilio/sms --data-urlencode "Body=This is Dana"
sleep 0.3; echo "-- 3. Caller: need"; post $CALLER /twilio/sms --data-urlencode "Body=Burst pipe under kitchen sink, water everywhere"
sleep 0.3; echo "-- 4. Caller: picks slot 1"; post $CALLER /twilio/sms --data-urlencode "Body=1"
sleep 0.3
URL=$(tail -n 5 "$LOG" | grep -o "$BASE/pay/mock/[a-f0-9]*" | tail -n1 || true)
if [ -n "$URL" ]; then echo "-- 5. Caller pays mock deposit: $URL"; curl -s "$URL" | sed 's/<[^>]*>/ /g' | tr -s ' '; echo
else echo "-- 5. (no mock deposit link: deposit/booking disabled or Stripe live)"; fi

echo; echo "== B. CLASSIC CALLBACK PATH ($CALLER2) - slot 1 above is now taken, so offers start later"
post $CALLER2 /twilio/voice/status --data-urlencode "DialCallStatus=no-answer"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=Mike"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=Water heater making a banging noise"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=callback"
sleep 0.3; post $CALLER2 /twilio/sms --data-urlencode "Body=after 3pm"

echo; echo "== SMS log (this run):"; tail -n +$((START+1)) "$LOG"
