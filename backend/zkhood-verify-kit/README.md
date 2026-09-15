# ZKHood Verify Kit

Independently verify a ZKHood blind trade — no trust in the operator required. This is a
standalone CLI: it only reads public on-chain data and the enclave's own public attestation
document. 
## What it checks

- **Unlinkability** — scans on-chain `DepositQueued`/`Withdrawn` events and proves your deposit
  and payout share no on-chain edge (different signers, no cross-references in either tx's logs).
- **Enclave attestation** — decodes the enclave's live AWS Nitro attestation document and checks
  its PCR0/1/2 against the published, reproducible-build values, and that the sealing key you
  encrypt orders to is cryptographically bound into that attestation.
- **Trade receipt** (optional) — given a `settleTx`, confirms `settleBatch` succeeded on-chain
  (which only happens if the SP1 proof verified). Given a `withdrawTx` and your `SECRET`,
  recomputes the nullifier locally to prove that withdrawal is yours.

## Setup

Requires Node.js 18+.

```bash
npm install
```

## Run

```bash
node verify-privacy.js
```

or, using the wrapper (defaults to the current production enclave IP):

```bash
bash verify.sh
bash verify.sh <ENCLAVE_IP>   # to point at a different deployment
```

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ROBINHOOD_TESTNET_RPC_URL` | `https://rpc.testnet.chain.robinhood.com` | Chain RPC endpoint |
| `ENCLAVE` | `http://13.200.190.217:4000` | Blind-sequencer enclave URL |
| `NITRO` | `http://13.200.190.217:1300` | Enclave's raw Nitro attestation endpoint |
| `SCAN_BLOCKS` | `400` | How far back to scan for deposit/withdraw events |
| `SETTLE_TX` | — | A specific trade's settlement tx, to check its receipt |
| `WITHDRAW_TX` | — | That trade's withdrawal tx |
| `SECRET` | — | Your trade secret — checked locally only, never sent over the network |
| `DEPLOYMENT_JSON` | bundled `deployments/robinhoodTestnet.json` | Override to point at a different deployment's contract addresses |

Example, verifying one specific trade:

```bash
SETTLE_TX=0x... WITHDRAW_TX=0x... SECRET=0x... node verify-privacy.js
```

## Reading the output

- `PASS` — the check succeeded.
- `OPEN` — something doesn't match; don't trust the result until this is resolved.
- For a full cryptographic signature check of the attestation against the AWS root (not just its
  contents), also run the canonical tool:
  ```bash
  oyster-cvm verify --enclave-ip <ip> --pcr0 <PCR0> --pcr1 <PCR1> --pcr2 <PCR2>
  ```
  (PCR values are printed by this CLI's Part B output.)
