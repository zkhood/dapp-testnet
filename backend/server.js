// ZKHood dApp backend — orchestrates the REAL TEE+ZK trade pipeline on our own contracts
// (Vault + ZkHoodRollup), the ones that actually verify the SP1 proof on-chain. The browser can't
// hold the enclave/SP1/deployer secrets, so this server runs the Rust sequencer (TEE execute +
// SP1 proof) and submits settleBatch; the wallet does deposit + withdraw itself.
//
// Endpoints:
//   GET  /api/market            -> tokens, prices, contract addresses (for the UI)
//   POST /api/trade {side,symbol,inputAmount,account,prover}
//        -> runs sequencer (trade batch) + submit-settlement; returns {nullifier, stockOut, txs}
//   static: serves ../zk (the dApp UI)
//
// Env (see .env / shell): ROBINHOOD_TESTNET_RPC_URL, OYSTER_URL (default local worker),
//   SP1_PROVER (default network). Reuses the sequencer's own .env for NETWORK_PRIVATE_KEY and the
//   contracts' .env for DEPLOYER_PRIVATE_KEY.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { ethers } = require("ethers");

const ZKVM_GUEST = "/root/zkhood/packages/zkvm/revm-guest";
const CONTRACTS = "/root/zkhood/packages/contracts";
const SEQUENCER_BIN = path.join(ZKVM_GUEST, "target/release/sequencer");
const MARKET_JSON = path.join(CONTRACTS, "deployments/market.robinhoodTestnet.json");
const DEPLOY_JSON = path.join(CONTRACTS, "deployments/robinhoodTestnet.json");
const SETTLEMENT = "/root/zkhood-settlement.json";
const OVERLAY = "/root/overlay.json";
const ORACLE_FILE = "/root/zkhood-oracle.json";
const PORT = process.env.PORT || 8788;
const OYSTER_URL = process.env.OYSTER_URL || "http://127.0.0.1:4000";
// Blind-sequencer (in the enclave): decrypts+executes+proves so the operator never sees the order.
const BLIND_URL = process.env.BLIND_URL || "http://127.0.0.1:4100";
const RPC = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const NOISE_SENDER = "0x1111111111111111111111111111111111111111";
const NOISE_RECIPIENT = "0x3333333333333333333333333333333333333333";

const ROLLUP_ABI = ["function batchNumber() view returns (uint64)"];

function market() {
  return JSON.parse(fs.readFileSync(MARKET_JSON, "utf8"));
}
function deployment() {
  return JSON.parse(fs.readFileSync(DEPLOY_JSON, "utf8"));
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "") + (stdout || "") + err.message));
      resolve(stdout + "\n" + stderr);
    });
  });
}

async function nextBatchNumber() {
  const d = deployment();
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const rollup = new ethers.Contract(d.contracts.ZkHoodRollup, ROLLUP_ABI, provider);
  const n = await rollup.batchNumber();
  return Number(n) + 1;
}

async function handleTrade(body) {
  const { side, symbol, inputAmount, account } = body;
  // The on-chain SP1 verifier is the REAL Groth16 v6.1.0 one — it rejects mock proofs, so a settled
  // trade must use a real network proof.
  const prover = "network";
  if (!["buy", "sell"].includes(side)) throw new Error("side must be buy|sell");
  if (!ethers.isAddress(account)) throw new Error("bad account");
  const m = market();
  const stock = m.stocks.find((s) => s.symbol === symbol);
  if (!stock) throw new Error("unknown symbol " + symbol);
  const quote = m.quote; // tUSD
  const inputWhole = String(inputAmount || "0");
  if (!(parseFloat(inputWhole) > 0)) throw new Error("inputAmount must be > 0");
  const inputWei = ethers.parseUnits(inputWhole, 18).toString();

  // The price oracle table the guest checks trades against IN-ZK, in AssetRegistry assetId order
  // (quote first, then stocks) so it matches AssetRegistry.oracleRoot() on-chain.
  const oracle = [{ token: quote.address, price: quote.price }, ...m.stocks.map((s) => ({ token: s.address, price: s.price }))];
  fs.writeFileSync(ORACLE_FILE, JSON.stringify(oracle));
  // Random per-trade secret => the withdrawal nullifier is unlinkable to the depositor/account.
  const secret = "0x" + crypto.randomBytes(32).toString("hex");
  // Withdrawals may go to a FRESH address (unlinkability); default to the trading account.
  const recipient = body.recipient && ethers.isAddress(body.recipient) ? ethers.getAddress(body.recipient) : account;

  const batchNo = await nextBatchNumber();
  if (batchNo === 1) { try { fs.unlinkSync(OVERLAY); } catch (_) {} } // fresh rollup -> fresh overlay
  const overlaySnap = fs.existsSync(OVERLAY) ? fs.readFileSync(OVERLAY) : null;
  const env = {
    ...process.env,
    OYSTER_URL,
    ZKHOOD_STATE_MODE: "mock",
    ZKHOOD_SENDER: NOISE_SENDER,
    ZKHOOD_RECIPIENT: NOISE_RECIPIENT,
    ZKHOOD_AMOUNT: "0",
    ZKHOOD_NONCE: String(batchNo - 1), // overlay-chained sender nonce
    ZKHOOD_TRADE_SIDE: side,
    ZKHOOD_TRADE_STOCK: stock.address,
    ZKHOOD_TRADE_QUOTE: quote.address,
    ZKHOOD_TRADE_INPUT: inputWei,
    ZKHOOD_TRADE_PRICE: stock.price, // on-chain oracle price (1e18)
    ZKHOOD_TRADE_ACCOUNT: recipient,
    ZKHOOD_TRADE_SECRET: secret,
    ORACLE_FILE,
    CHAIN_ID: String(CHAIN_ID),
    BATCH_NUMBER: String(batchNo),
    SP1_PROVER: prover,
    OUTPUT: SETTLEMENT,
    OVERLAY_PATH: OVERLAY,
  };

  try {
    const seqOut = await run(SEQUENCER_BIN, [], { cwd: ZKVM_GUEST, env });
    const teeAgree = /TEE and SP1 proof agree/.test(seqOut);
    const bundle = JSON.parse(fs.readFileSync(SETTLEMENT, "utf8"));

    const submitOut = await run(
      "npx",
      ["hardhat", "run", "scripts/submit-settlement.ts", "--network", "robinhoodTestnet"],
      { cwd: CONTRACTS, env: { ...process.env, SETTLEMENT_PATH: SETTLEMENT } }
    );
    const settleTx = (submitOut.match(/tx:\s*(0x[0-9a-fA-F]{64})/) || [])[1] || null;
    const settled = /BatchSettled/.test(submitOut);
    if (!settled || !settleTx) throw new Error("settleBatch did not confirm:\n" + submitOut.slice(-400));

    const w = bundle.withdrawals[0];
    // RELAYER-submitted withdrawal: the payout tx is signed by the relayer, NOT the depositor, so an
    // on-chain observer cannot link the deposit to the withdrawal via the caller. Funds go to `recipient`
    // (use a fresh address to also break the recipient link). Honest limit: the relayer itself knows the
    // mapping (it ran the trade); this hides the link from chain observers, not from the operator.
    let withdrawTx = null;
    if (process.env.DEPLOYER_PRIVATE_KEY) {
      try {
        const relayer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(RPC, CHAIN_ID));
        const vault = new ethers.Contract(deployment().contracts.Vault, ["function withdraw(bytes32 nullifier)"], relayer);
        const wtx = await vault.withdraw(w.nullifier);
        await wtx.wait();
        withdrawTx = wtx.hash;
      } catch (_) { /* leave null; the withdrawal stays claimable by anyone */ }
    }
    return {
      ok: true,
      side,
      symbol,
      batchNumber: bundle.batch_number,
      teeAgree,
      proofSelector: bundle.proof.slice(0, 10),
      proofBytes: (bundle.proof.length - 2) / 2,
      vkey: bundle.vkey,
      attestation: bundle.attestation_hash,
      attestationStatus: bundle.attestation_status,
      nullifier: w.nullifier,
      outputToken: ethers.getAddress(w.stock_token),
      outputAmount: w.amount,
      outputAmountWhole: ethers.formatUnits(BigInt(w.amount), 18),
      recipient,
      settleTx,
      withdrawTx,
      relayed: !!withdrawTx,
    };
  } catch (e) {
    // A failed proof/settle must not desync the overlay from on-chain: restore the pre-trade snapshot.
    if (overlaySnap) fs.writeFileSync(OVERLAY, overlaySnap);
    else { try { fs.unlinkSync(OVERLAY); } catch (_) {} }
    throw e;
  }
}

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(buf);
}

// Operator-blind trade: the browser already encrypted the order to the enclave; we only ever relay
// ciphertext to the blind-sequencer, which decrypts+executes+proves inside. We never see the order.
async function handleTradeBlind(body) {
  const sealed = body.sealed;
  if (!sealed || !sealed.eph_pub || !sealed.iv || !sealed.ct) throw new Error("missing sealed order");
  const m = market();
  const oracle = [{ token: m.quote.address, price: m.quote.price }, ...m.stocks.map((s) => ({ token: s.address, price: s.price }))];
  const batchNo = await nextBatchNumber();
  if (batchNo === 1) { try { fs.unlinkSync(OVERLAY); } catch (_) {} }
  const overlaySnap = fs.existsSync(OVERLAY) ? fs.readFileSync(OVERLAY) : null;
  const blindReq = { sealed, batch_number: batchNo, chain_id: CHAIN_ID, rollup_id: "0x00000000000000000000000000000000000000AA", oracle };
  if (batchNo > 1 && overlaySnap) blindReq.overlay = JSON.parse(overlaySnap.toString());
  try {
    const r = await fetch(`${BLIND_URL}/execute-blind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blindReq) });
    const out = await r.json();
    if (out.error) throw new Error(out.error);
    const w = out.withdrawals[0];
    const bundle = {
      batch_number: batchNo,
      public_values: out.public_values,
      proof: out.proof,
      withdrawals: out.withdrawals.map((x) => ({ nullifier: x.nullifier, stock_token: x.stock_token, amount: x.amount, recipient: x.recipient })),
      vkey: out.vkey,
      attestation_hash: out.attestation_hash,
      attestation_status: out.attestation_status,
    };
    fs.writeFileSync(SETTLEMENT, JSON.stringify(bundle));
    if (out.new_overlay) fs.writeFileSync(OVERLAY, JSON.stringify(out.new_overlay));
    const submitOut = await run("npx", ["hardhat", "run", "scripts/submit-settlement.ts", "--network", "robinhoodTestnet"], { cwd: CONTRACTS, env: { ...process.env, SETTLEMENT_PATH: SETTLEMENT } });
    const settleTx = (submitOut.match(/tx:\s*(0x[0-9a-fA-F]{64})/) || [])[1] || null;
    if (!/BatchSettled/.test(submitOut) || !settleTx) throw new Error("settleBatch did not confirm:\n" + submitOut.slice(-400));
    let withdrawTx = null;
    if (process.env.DEPLOYER_PRIVATE_KEY) {
      try {
        const relayer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(RPC, CHAIN_ID));
        const vault = new ethers.Contract(deployment().contracts.Vault, ["function withdraw(bytes32 nullifier)"], relayer);
        const wtx = await vault.withdraw(w.nullifier);
        await wtx.wait();
        withdrawTx = wtx.hash;
      } catch (_) {}
    }
    return {
      ok: true, blind: true, teeAgree: out.tee_agree,
      proofSelector: out.proof.slice(0, 10), proofBytes: (out.proof.length - 2) / 2, vkey: out.vkey,
      attestation: out.attestation_hash, attestationStatus: out.attestation_status,
      nullifier: w.nullifier, outputToken: ethers.getAddress(w.stock_token), outputAmount: w.amount,
      outputAmountWhole: ethers.formatUnits(BigInt(w.amount), 18), recipient: ethers.getAddress(w.recipient),
      settleTx, withdrawTx, relayed: !!withdrawTx,
    };
  } catch (e) {
    if (overlaySnap) fs.writeFileSync(OVERLAY, overlaySnap);
    else { try { fs.unlinkSync(OVERLAY); } catch (_) {} }
    throw e;
  }
}

const STATIC_DIR = path.join(__dirname, "frontend");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const handler = (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/market") {
    try {
      const m = market();
      return send(res, 200, { chainId: m.chainId, contracts: m.contracts, quote: m.quote, stocks: m.stocks, oyster: OYSTER_URL, blind: BLIND_URL });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  // Proxy the enclave's sealed-order public key so the browser can encrypt to it (same origin).
  if (url.pathname === "/api/pubkey") {
    fetch(`${BLIND_URL}/pubkey`)
      .then((r) => r.json())
      .then((j) => send(res, 200, j))
      .catch((e) => send(res, 502, { error: "blind-sequencer unreachable: " + String(e.message || e) }));
    return;
  }

  // Proxy the enclave's hardware attestation (browser can't reach the enclave's loopback :1300).
  if (url.pathname === "/api/attestation") {
    fetch(`${BLIND_URL}/attestation`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => send(res, 200, j))
      .catch((e) => send(res, 502, { error: "blind-sequencer unreachable: " + String(e.message || e) }));
    return;
  }

  if (url.pathname === "/api/trade-blind" && req.method === "POST") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      try {
        send(res, 200, await handleTradeBlind(JSON.parse(data || "{}")));
      } catch (e) {
        send(res, 500, { error: String(e.message || e).slice(0, 2000) });
      }
    });
    return;
  }


  if (url.pathname === "/api/trade" && req.method === "POST") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(data || "{}");
        const result = await handleTrade(body);
        send(res, 200, result);
      } catch (e) {
        send(res, 500, { error: String(e.message || e).slice(0, 2000) });
      }
    });
    return;
  }

  // static
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(STATIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
};

// Serve HTTPS when a self-signed cert exists (WebCrypto needs a secure context, unavailable on a bare
// LAN-IP http:// origin). Falls back to http otherwise. Generate certs with: scripts/gen-cert.sh
const CERT_DIR = process.env.CERT_DIR || "/root/zkhood-dapp/certs";
const keyPath = path.join(CERT_DIR, "key.pem");
const certPath = path.join(CERT_DIR, "cert.pem");
let server, scheme;
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler);
  scheme = "https";
} else {
  server = http.createServer(handler);
  scheme = "http";
}

server.listen(PORT, () => {
  console.log(`ZKHood dApp backend on ${scheme}://0.0.0.0:${PORT}  (oyster=${OYSTER_URL}, rpc=<hidden>)`);
  if (scheme === "http") console.log("WARNING: serving http — WebCrypto (order sealing) works only on localhost/HTTPS. Add certs in " + CERT_DIR + " for LAN access.");
});
