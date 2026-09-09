#!/usr/bin/env bash
# Run after the enclave (blind-sequencer) is deployed. Usage: bash post-deploy.sh <ENCLAVE_IP>
# Points the dApp backend at the new enclave, waits for it to boot, and verifies the sealing-key binding.
set -uo pipefail
IP="${1:?usage: post-deploy.sh <ENCLAVE_IP>}"
BASE="http://$IP:4000"
echo "$IP" > /root/zkhood-dapp/.enclave-ip   # remembered by verify.sh

echo "=== 1) waiting for enclave $BASE/health (up to ~4 min) ==="
for i in $(seq 1 48); do
  if curl -s -m 5 "$BASE/health" | grep -q '"status":"ok"'; then echo "enclave up"; break; fi
  sleep 5; printf '.'
done
echo

echo "=== 2) enclave sealing key (/pubkey) ==="
curl -s -m 8 "$BASE/pubkey" | head -c 220; echo

echo "=== 3) attestation (expect bound:true now that /dev/nsm is mounted) ==="
curl -s -m 15 "$BASE/attestation" | head -c 400; echo

echo "=== 4) restart dApp backend -> $BASE ==="
cd /root/zkhood-dapp
fuser -k 8788/tcp 2>/dev/null; sleep 1
# Source RPC + relayer key so the backend can submit the relayer withdrawal (else payouts stay "queued").
set -a; . /root/zkhood/packages/contracts/.env; set +a
BLIND_URL="$BASE" nohup node server.js > /root/zkhood-dapp/backend.log 2>&1 &
echo "backend pid=$!"; sleep 2
# Never cat the log on-camera; confirm via a health probe instead (backend.log may hold the RPC).
curl -sk -m 5 https://127.0.0.1:8788/api/market >/dev/null && echo "backend up on :8788 ✓" || echo "backend not responding yet"

echo "=== 5) full privacy + binding verifier ==="
ENCLAVE="$BASE" NITRO="http://$IP:1300" node /root/zkhood-dapp/verify-privacy.js
