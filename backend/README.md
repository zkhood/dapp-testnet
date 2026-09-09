 ZKHood — dApp Backend (testnet)

Node backend for the **ZKHood** dApp: private, operator-blind stock trading on **Robinhood Chain testnet** (chainId `46630`), using a TEE (AWS Nitro via Oyster) and ZK proofs (SP1 groth16) verified on-chain.

This repository contains **only the dApp backend** (the Node server that orchestrates the TEE+ZK pipeline) and the **verifier** scripts. It does not include the frontend (separate repo) or the Solidity contracts / Rust sequencer (separate platform).

## Runtime dependency

The backend is not self-contained: at runtime it invokes the enclave sequencer and reads the contract deployments, which live in a separate repo/path. This code is published as source to read and verify.

## Files

| File | Description |
|---|---|
| `server.js` | The backend server. HTTP/HTTPS. Exposes `/api/market` (tokens, prices, contract addresses), `/api/pubkey` and `/api/attestation` (proxy to the enclave), and `/api/trade-blind` / `/api/trade` (runs the operator-blind trade: the enclave decrypts → executes → proves, then the server submits `settleBatch` on-chain). Never logs the RPC (`rpc=<hidden>`). Reads keys only from environment variables. |
| `verify-privacy.js` | Standalone verifier. PART A: on-chain unlinkability (deposit vs withdrawal). PART B: decodes the AWS Nitro attestation, compares PCR0/1/2 against pinned values, and checks the sealing key is bound. PART C: per-transaction receipt (`settleBatch` verified, `Withdrawn`, nullifier recomputed from the secret). |
| `verify.sh` | Wrapper that runs `verify-privacy.js` with the right parameters (enclave IP, block range, optional `SETTLE_TX`/`WITHDRAW_TX`/`SECRET`). |
| `post-deploy.sh` | Startup script: waits for the enclave `/health`, shows `/pubkey`, checks `bound:true`, loads env (RPC + relayer key), starts `node server.js` on `:8788`, and prints the proof. |
| `point-backend-to-enclave.sh` | Points the backend at a given enclave IP (saves the IP and restarts the server against it). |
| `backend-blind-test.js` | End-to-end test that simulates the browser doing the operator-blind trade through the backend (`/api/pubkey` → encrypt → `/api/trade-blind`). |
| `package.json` / `package-lock.json` | Node dependencies (`ethers`, `cbor`, `dotenv`). |
| `.env.example` | Template for the environment variables (empty values). |

## Configuration

Copy `.env.example` to a local `.env` and fill in:

| Variable | Use |
|---|---|
| `ROBINHOOD_TESTNET_RPC_URL` | Testnet RPC endpoint (chainId 46630). |
| `DEPLOYER_PRIVATE_KEY` | Relayer key that signs `settleBatch` / withdrawals (testnet). |
| `BLIND_URL` | Enclave blind-sequencer URL (default `http://127.0.0.1:4100`). |
| `OYSTER_URL` | Oyster worker URL (default `http://127.0.0.1:4000`). |
| `PORT` | Backend port (default `8788`). |

No keys are hardcoded in the source; everything is read from `process.env`.

## Verify

```bash
# full check: unlinkability + enclave attestation + PCR/binding
bash verify.sh

# single-transaction receipt
SETTLE_TX=0x... WITHDRAW_TX=0x... bash verify.sh

# proof of ownership (only the holder of the secret)
SETTLE_TX=0x... WITHDRAW_TX=0x... SECRET=0x... bash verify.sh
```

AWS hardware signature (Marlin tool):

```bash
oyster-cvm verify --enclave-ip <ENCLAVE_IP> --pcr0 <PCR0> --pcr1 <PCR1> --pcr2 <PCR2>
```

## Notes

- Do not commit `.env`, TLS certificates (`certs/`), logs (`backend.log`), or the ephemeral enclave IP (`.enclave-ip`).
- Testnet software. Tokens do not represent real shares and have no backing/custody.

