import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK, PORT, RPC_URL, SOL, baseUrlFrom } from "./config.js";
import { gatewayProxy, PAYMENT_HEADER } from "./proxy.js";
import {
  connection,
  demoPayerKeypair,
  ensureFunded,
  explorerAddress,
  explorerTx,
  merchantKeypair,
  payInvoice,
} from "./solana.js";
import { store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

/* ------------------------------------------------------------------ *
 * Metered proxy — mounted before the JSON body parser so upstream
 * payloads pass through byte-for-byte.
 * ------------------------------------------------------------------ */
app.use("/g/:gatewayId", express.raw({ type: "*/*", limit: "2mb" }), gatewayProxy);

app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ *
 * Control plane
 * ------------------------------------------------------------------ */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tollgate", network: NETWORK, uptimeSeconds: Math.round(process.uptime()) });
});

app.get("/api/config", (req, res) => {
  res.json({
    network: NETWORK,
    rpcUrl: RPC_URL,
    merchant: merchantKeypair.publicKey.toBase58(),
    merchantExplorer: explorerAddress(merchantKeypair.publicKey.toBase58()),
    defaultPriceLamports: 1_000_000,
    paymentHeader: PAYMENT_HEADER,
    baseUrl: baseUrlFrom(req),
  });
});

app.get("/api/gateways", (_req, res) => {
  res.json({ gateways: store.listGateways() });
});

app.post("/api/gateways", (req, res) => {
  const { name, upstream, priceSol, priceLamports, recipient } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "invalid_name", message: "name is required" });
    return;
  }
  if (typeof upstream !== "string" || !/^https?:\/\//.test(upstream)) {
    res.status(400).json({ error: "invalid_upstream", message: "upstream must be an http(s) URL" });
    return;
  }

  const lamports = priceLamports ?? (typeof priceSol === "number" ? Math.round(priceSol * SOL) : 1_000_000);
  if (!Number.isFinite(lamports) || lamports <= 0) {
    res.status(400).json({ error: "invalid_price", message: "price must be a positive number" });
    return;
  }

  const payout = typeof recipient === "string" && recipient.trim() ? recipient.trim() : merchantKeypair.publicKey.toBase58();
  const gateway = store.createGateway({
    name: name.trim(),
    upstream: upstream.trim(),
    priceLamports: Math.floor(lamports),
    recipient: payout,
  });
  res.status(201).json({ gateway, callUrl: `${baseUrlFrom(req)}${gateway.path}` });
});

app.get("/api/gateways/:id", (req, res) => {
  const gateway = store.getGateway(req.params.id);
  if (!gateway) {
    res.status(404).json({ error: "unknown_gateway" });
    return;
  }
  res.json({ gateway });
});

app.get("/api/invoices", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
  res.json({ invoices: store.listInvoices(limit), stats: store.stats() });
});

/** Poll target for a caller waiting on settlement. */
app.get("/api/invoices/:reference", async (req, res) => {
  const invoice = store.getInvoice(req.params.reference);
  if (!invoice) {
    res.status(404).json({ error: "unknown_invoice" });
    return;
  }
  if (invoice.status === "pending" && Date.parse(invoice.expiresAt) > Date.now()) {
    try {
      const { verifySettlement } = await import("./solana.js");
      const settlement = await verifySettlement({
        reference: invoice.reference,
        recipient: invoice.recipient,
        minLamports: invoice.priceLamports,
      });
      if (settlement.paid && settlement.signature) {
        store.markPaid(invoice.reference, settlement.signature, settlement.payer);
      }
    } catch {
      /* transient RPC failure — fall back to the stored invoice state */
    }
  }
  const fresh = store.getInvoice(req.params.reference)!;
  res.json({
    invoice: fresh,
    explorer: fresh.signature ? explorerTx(fresh.signature) : null,
  });
});

app.get("/api/stats", (_req, res) => {
  store.expireStale();
  res.json({ stats: store.stats(), gateways: store.listGateways() });
});

/** Where to send devnet SOL if the built-in paying wallet ever runs dry. */
app.get("/api/demo/funding", async (_req, res) => {
  const [payer, merchant] = await Promise.all([
    connection.getBalance(demoPayerKeypair.publicKey),
    connection.getBalance(merchantKeypair.publicKey),
  ]);
  const payerAddress = demoPayerKeypair.publicKey.toBase58();
  res.json({
    network: NETWORK,
    payingAgent: {
      address: payerAddress,
      balanceSol: payer / SOL,
      explorer: explorerAddress(payerAddress),
    },
    merchant: {
      address: merchantKeypair.publicKey.toBase58(),
      balanceSol: merchant / SOL,
      explorer: explorerAddress(merchantKeypair.publicKey.toBase58()),
    },
    faucets: [
      `https://faucet.solana.com/?address=${payerAddress}`,
      "https://solfaucet.com/",
    ],
  });
});

/**
 * Receipt inspector — re-reads a settlement straight from the cluster.
 *
 * This is the evidence view: rather than trusting the gateway's own bookkeeping, anyone can
 * pull the raw transaction back out of the RPC and see the memo, the fee, the slot and the
 * lamport movement that the paywall verified.
 */
app.get("/api/receipts/:signature", async (req, res) => {
  const signature = req.params.signature;
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) {
      res.status(404).json({ error: "transaction_not_found", signature });
      return;
    }

    const message = tx.transaction.message;
    const keys = message.accountKeys.map((k: any) => k.pubkey.toBase58());
    const changes = keys
      .map((account: string, index: number) => ({
        account,
        deltaLamports: tx.meta!.postBalances[index] - tx.meta!.preBalances[index],
      }))
      .filter((change: { deltaLamports: number }) => change.deltaLamports !== 0);

    let memo: string | null = null;
    for (const instruction of message.instructions as any[]) {
      const program = instruction.program ?? instruction.programId?.toBase58?.();
      if (
        program === "spl-memo" ||
        instruction.programId?.toBase58?.() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
      ) {
        memo =
          typeof instruction.parsed === "string"
            ? instruction.parsed
            : Buffer.from(instruction.data ?? "", "base64").toString("utf8");
      }
    }

    res.json({
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      err: tx.meta.err,
      fee: tx.meta.fee,
      memo,
      balanceChanges: changes,
      explorer: explorerTx(signature),
    });
  } catch (error) {
    res.status(502).json({ error: "receipt_lookup_failed", message: (error as Error).message });
  }
});

/* ------------------------------------------------------------------ *
 * Built-in sandbox upstream — the paid API the self-test buys from.
 * It serves live Solana cluster data, so paying for it is genuinely useful.
 * ------------------------------------------------------------------ */
const sandbox = express.Router();

sandbox.get("/network-report", async (_req, res) => {
  const [slot, epoch, blockHeight, perf] = await Promise.all([
    connection.getSlot("confirmed"),
    connection.getEpochInfo("confirmed"),
    connection.getBlockHeight("confirmed"),
    connection.getRecentPerformanceSamples(5),
  ]);
  const samples = perf.filter((s) => s.samplePeriodSecs > 0);
  const tps = samples.length
    ? samples.reduce((sum, s) => sum + s.numTransactions / s.samplePeriodSecs, 0) / samples.length
    : null;
  res.json({
    source: "solana-devnet",
    generatedAt: new Date().toISOString(),
    slot,
    blockHeight,
    epoch: { number: epoch.epoch, progressPct: Number(((epoch.slotIndex / epoch.slotsInEpoch) * 100).toFixed(2)) },
    avgTps: tps === null ? null : Number(tps.toFixed(1)),
  });
});

sandbox.get("/priority-fees", async (_req, res) => {
  const fees = await connection.getRecentPrioritizationFees();
  const recent = fees.slice(-20).map((f) => f.prioritizationFee).filter((f) => f > 0);
  recent.sort((a, b) => a - b);
  res.json({
    source: "solana-devnet",
    samples: recent.length,
    medianMicroLamports: recent.length ? recent[Math.floor(recent.length / 2)] : 0,
    maxMicroLamports: recent.length ? recent[recent.length - 1] : 0,
  });
});

sandbox.post("/echo", (req, res) => {
  res.json({ youSent: req.body ?? null, metered: true, at: new Date().toISOString() });
});

app.use("/sandbox", sandbox);

/* ------------------------------------------------------------------ *
 * One-click self test: runs the whole agentic payment loop end to end.
 * ------------------------------------------------------------------ */
app.post("/api/demo/run", async (req, res) => {
  const base = `http://127.0.0.1:${PORT}`;
  const steps: Array<Record<string, unknown>> = [];
  const started = Date.now();

  try {
    let gateway = store.listGateways().find((g) => g.name === "Built-in Sandbox");
    if (!gateway) {
      gateway = store.createGateway({
        name: "Built-in Sandbox",
        upstream: `${base}/sandbox`,
        priceLamports: 1_000_000,
        recipient: merchantKeypair.publicKey.toBase58(),
      });
    }
    const callUrl = `${base}${gateway.path}/network-report`;
    steps.push({ step: 1, name: "Call the metered endpoint with no payment", url: callUrl });

    const unpaid = await fetch(callUrl);
    const challenge = (await unpaid.json()) as Record<string, any>;
    steps.push({
      step: 2,
      name: "Gateway answers with a payment challenge",
      status: unpaid.status,
      challenge: {
        network: challenge.network,
        priceSol: challenge.priceSol,
        recipient: challenge.recipient,
        reference: challenge.reference,
        expiresAt: challenge.expiresAt,
      },
    });

    const funding = await ensureFunded(demoPayerKeypair, 0.05, {
      keypair: merchantKeypair,
      keepSol: 0.15,
    });
    steps.push({
      step: 3,
      name: "Prepare the paying agent wallet",
      payer: funding.address,
      balanceSol: Number(funding.balanceSol.toFixed(4)),
      funded: funding.funded,
      source: funding.source,
      note: funding.note,
    });

    if (!funding.funded) {
      res.json({
        ok: false,
        error: "paying_agent_wallet_unfunded",
        message:
          "The built-in paying agent has no devnet SOL, and the faucet is rate limited right now. " +
          "Send a little devnet SOL to the address below and run the self-test again.",
        payingAgent: {
          address: funding.address,
          explorer: explorerAddress(funding.address),
          faucet: `https://faucet.solana.com/?address=${funding.address}`,
        },
        steps,
      });
      return;
    }

    let signature: string | null = null;
    let settleNote: string | null = null;
    try {
      signature = await payInvoice({
        payer: demoPayerKeypair,
        recipient: challenge.recipient,
        amountLamports: challenge.priceLamports,
        reference: challenge.reference,
        memo: challenge.memo,
      });
    } catch (error) {
      // The transfer may still have landed — the gateway verifies on chain by itself, so
      // report the client-side uncertainty and let the replay below decide the outcome.
      settleNote = (error as Error).message;
    }
    steps.push({
      step: 4,
      name: signature
        ? "Agent settles the invoice on Solana"
        : "Agent submitted the payment — awaiting cluster confirmation",
      signature,
      explorer: signature ? explorerTx(signature) : null,
      note: settleNote,
    });

    // Replay until the gateway's own on-chain verification unlocks the call. This is
    // deliberately independent of the client-side confirmation above: a settlement that
    // confirmed slowly still has to pay off.
    let payload: unknown = null;
    let verifiedSignature: string | null = null;
    let paidStatus = 402;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const response = await fetch(callUrl, {
        headers: { [PAYMENT_HEADER]: challenge.reference },
      });
      paidStatus = response.status;
      if (response.status === 200) {
        verifiedSignature = response.headers.get("x-tollgate-signature");
        payload = await response.json();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    steps.push({
      step: 5,
      name: "Replay with the payment reference — gateway verifies on chain and proxies",
      status: paidStatus,
      verifiedSignature,
      explorer: verifiedSignature ? explorerTx(verifiedSignature) : null,
      payload,
    });

    res.json({
      ok: paidStatus === 200,
      elapsedMs: Date.now() - started,
      gatewayId: gateway.id,
      steps,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: (error as Error).message,
      steps,
    });
  }
});

/* ------------------------------------------------------------------ *
 * Static UI
 * ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, () => {
  console.log(`Tollgate listening on http://0.0.0.0:${PORT}`);
  console.log(`  network : ${NETWORK} (${RPC_URL})`);
  console.log(`  merchant: ${merchantKeypair.publicKey.toBase58()}`);
  console.log(`  demo    : POST http://127.0.0.1:${PORT}/api/demo/run`);
});
