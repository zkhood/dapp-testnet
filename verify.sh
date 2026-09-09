#!/usr/bin/env bash
# Final privacy + enclave proof, for the video. Uses the enclave IP saved by post-deploy.sh.
# Override with: bash verify.sh <ENCLAVE_IP>
set -uo pipefail
IP="${1:-$(cat /root/zkhood-dapp/.enclave-ip 2>/dev/null)}"
if [ -z "${IP:-}" ]; then echo "no enclave IP — run: bash verify.sh <ENCLAVE_IP>"; exit 1; fi
cd /root/zkhood-dapp
set -a; . /root/zkhood/packages/contracts/.env; set +a
echo "### Proving against enclave $IP ###"
ENCLAVE="http://$IP:4000" NITRO="http://$IP:1300" SCAN_BLOCKS=60000 node verify-privacy.js
