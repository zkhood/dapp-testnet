#!/usr/bin/env bash
# Portable wrapper for the ZKHood verification CLI. No operator server paths required.
# Usage: bash verify.sh [ENCLAVE_IP]
set -uo pipefail
IP="${1:-65.1.36.224}"
cd "$(dirname "$0")"
ENCLAVE="http://$IP:4000" NITRO="http://$IP:1300" SCAN_BLOCKS=60000 node verify-privacy.js
