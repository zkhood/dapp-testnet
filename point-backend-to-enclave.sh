#!/usr/bin/env bash
# Repoint the ZKHood dApp backend at a REAL Oyster enclave (instead of a local worker), so every
# trade executes inside the enclave and the dApp shows a genuine AWS Nitro attestation.
# Usage: ./point-backend-to-enclave.sh <enclave-ip>
set -euo pipefail

IP="${1:?usage: $0 <enclave-ip>}"
OYSTER_URL="http://${IP}:4000"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> checking enclave worker at $OYSTER_URL"
curl -s -m 8 "$OYSTER_URL/health" >/dev/null && echo "   worker health: ok" || { echo "   worker not reachable at $OYSTER_URL"; exit 1; }
echo "==> enclave attestation:"
curl -s -m 10 "$OYSTER_URL/attestation" | head -c 200; echo

echo "==> restarting dApp backend pointed at the enclave"
pkill -f "server.js" 2>/dev/null || true
sleep 1
cd "$HERE"
set -a; source /root/zkhood/packages/contracts/.env 2>/dev/null || true; set +a
OYSTER_URL="$OYSTER_URL" nohup node server.js > /tmp/dapp-backend.log 2>&1 &
sleep 2
curl -s -m 6 http://127.0.0.1:8788/api/market >/dev/null && echo "   dApp backend :8788 up (oyster=$OYSTER_URL)" || echo "   backend failed — see /tmp/dapp-backend.log"
echo
echo "Open the dApp at http://<this-host>:8788 — trades now run in the enclave with a real Nitro attestation."
