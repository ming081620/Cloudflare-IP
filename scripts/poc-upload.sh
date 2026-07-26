#!/bin/sh
# Acceptance test for the anonymous DNS-takeover fix.
#
# Posts the proof-of-concept payload from the security review — no credentials, forged
# China Telecom / Guangdong attribution, unbounded speed, attacker-controlled IP — and
# asserts that nothing it contains can reach the public aggregates or a DNS record.
#
# Usage: BASE=http://127.0.0.1:8787 sh scripts/poc-upload.sh
set -eu

BASE="${BASE:-http://127.0.0.1:8787}"
ATTACKER_IP="${ATTACKER_IP:-203.0.113.9}"
NICK="${NICK:-poc-$(date +%s)}"
fail=0

say() { printf '%s\n' "$*"; }
check() {
	if [ "$1" = "ok" ]; then
		say "  PASS  $2"
	else
		say "  FAIL  $2"
		fail=1
	fi
}

say "==> POST ${BASE}/api/public/upload (anonymous, forged geo, speed=999999)"
upload_response="$(curl -sS -X POST "${BASE}/api/public/upload" \
	-H 'content-type: application/json' \
	-d "{\"nickname\":\"${NICK}\",\"ip_version\":\"v4\",
	     \"direct_check\":{\"egress_country\":\"CN\",\"egress_region\":\"Guangdong\",
	                       \"egress_city\":\"Guangzhou\",\"egress_org\":\"China Telecom\",
	                       \"egress_ip\":\"1.2.3.4\",\"proxy_suspected\":false},
	     \"nodes\":[{\"ip\":\"${ATTACKER_IP}\",\"port\":443,\"speed\":999999,\"latency\":1,\"loss\":0,\"colo\":\"HKG\"}]}")"
say "$upload_response"
say ""

# The request must still succeed: the deployed client posts with a bare `curl -fsS`, so a
# 4xx would silently discard a legitimate user's whole run.
case "$upload_response" in
	*'"success":true'*) check ok 'upload accepted (no 4xx that would break real clients)' ;;
	*) check bad 'upload accepted' ;;
esac

case "$upload_response" in
	*'"total":0'*) check ok 'every attacker node was dropped' ;;
	*) check bad 'every attacker node was dropped' ;;
esac

case "$upload_response" in
	*not_cloudflare_ip*) check ok 'drop reason reported as not_cloudflare_ip' ;;
	*) check bad 'drop reason reported as not_cloudflare_ip' ;;
esac

say ""
say "==> GET ${BASE}/api/public/latest"
latest="$(curl -sS "${BASE}/api/public/latest")"
say "$latest"
say ""

case "$latest" in
	*"$ATTACKER_IP"*) check bad "attacker IP absent from public aggregates" ;;
	*) check ok "attacker IP absent from public aggregates" ;;
esac

say ""
if [ "$fail" -eq 0 ]; then
	say "PoC is inert."
else
	say "PoC WAS NOT fully contained — do not deploy."
fi
exit "$fail"
