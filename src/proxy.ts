import type { Request, Response } from "express";
import { NETWORK, SOL, baseUrlFrom } from "./config.js";
import { createPaymentReference, explorerTx, verifySettlement } from "./solana.js";
import { store, type Gateway, type Invoice } from "./store.js";

const PAYMENT_HEADER = "x-tollgate-payment";

function paymentRefFrom(req: Request): string | undefined {
  const header = req.header(PAYMENT_HEADER);
  if (header) return header.trim();
  const query = req.query.tollgate_payment;
  if (typeof query === "string" && query.trim()) return query.trim();
  return undefined;
}

/** Quote a fresh invoice and describe, in machine-readable form, exactly how to settle it. */
function issueChallenge(req: Request, gateway: Gateway): Record<string, unknown> {
  const reference = createPaymentReference();
  const referenceKey = reference.publicKey.toBase58();
  const invoice: Invoice = store.createInvoice({
    reference: referenceKey,
    gateway,
    method: req.method,
    path: req.originalUrl,
  });
  const base = baseUrlFrom(req);

  return {
    error: "payment_required",
    message: "This endpoint is metered. Pay the quoted amount on Solana and retry with the reference attached.",
    scheme: "solana-pay-reference",
    network: NETWORK,
    gatewayId: gateway.id,
    priceLamports: invoice.priceLamports,
    priceSol: invoice.priceLamports / SOL,
    recipient: invoice.recipient,
    reference: referenceKey,
    invoice: referenceKey,
    memo: `tollgate:${gateway.id}`,
    expiresAt: invoice.expiresAt,
    verifyUrl: `${base}/api/invoices/${referenceKey}`,
    retryHeader: PAYMENT_HEADER,
    howTo: [
      `Build a Solana transfer of ${invoice.priceLamports / SOL} SOL to ${invoice.recipient}.`,
      `Attach the reference account ${referenceKey} to the transfer instruction as a read-only, non-signer key.`,
      `Add the memo "tollgate:${gateway.id}" so the payment is self-describing on-chain.`,
      `Replay this request with the header ${PAYMENT_HEADER}: ${referenceKey}.`,
    ],
    tools: {
      cli: `npx tsx scripts/agent-pay.ts "${base}${gateway.path}/network-report"`,
      explorer: `https://explorer.solana.com/address/${referenceKey}${NETWORK === "mainnet-beta" ? "" : `?cluster=${NETWORK}`}`,
    },
  };
}

/** The metered reverse proxy. 402 until settled, then transparent passthrough. */
export async function gatewayProxy(req: Request, res: Response): Promise<void> {
  const gatewayId = String(req.params.gatewayId);
  const gateway = store.getGateway(gatewayId);
  if (!gateway) {
    res.status(404).json({
      error: "unknown_gateway",
      message: `No gateway registered under /g/${gatewayId}.`,
    });
    return;
  }

  const reference = paymentRefFrom(req);
  if (!reference) {
    res.status(402).json(issueChallenge(req, gateway));
    return;
  }

  const invoice = store.getInvoice(reference);
  if (!invoice || invoice.gatewayId !== gateway.id) {
    res.status(402).json({
      error: "unknown_invoice",
      message: "That payment reference was not issued by this gateway.",
      retryHeader: PAYMENT_HEADER,
    });
    return;
  }

  if (invoice.status !== "paid") {
    if (Date.parse(invoice.expiresAt) < Date.now()) {
      res.status(402).json({
        ...issueChallenge(req, gateway),
        error: "invoice_expired",
        message: "The quoted invoice expired before it was settled. Here is a fresh one.",
      });
      return;
    }

    let settlement;
    try {
      settlement = await verifySettlement({
        reference: invoice.reference,
        recipient: invoice.recipient,
        minLamports: invoice.priceLamports,
      });
    } catch (error) {
      res.status(502).json({
        error: "verification_failed",
        message: `Could not reach the Solana cluster: ${(error as Error).message}`,
      });
      return;
    }

    if (!settlement.paid || !settlement.signature) {
      res.status(402).json({
        error: "payment_not_settled",
        message: "No confirmed transfer for this reference yet. Settle it on chain, then replay the request.",
        invoice: invoice.reference,
        priceLamports: invoice.priceLamports,
        recipient: invoice.recipient,
        verifyUrl: `${baseUrlFrom(req)}/api/invoices/${invoice.reference}`,
        retryHeader: PAYMENT_HEADER,
      });
      return;
    }

    store.markPaid(invoice.reference, settlement.signature, settlement.payer);
  }

  const settled = store.getInvoice(reference);
  const target = gateway.upstream + req.url.replace(/^\//, "/");

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        accept: req.header("accept") ?? "application/json",
        "content-type": req.header("content-type") ?? "application/json",
        "user-agent": req.header("user-agent") ?? "tollgate/1.0",
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.body as Buffer | undefined),
    });
  } catch (error) {
    res.status(502).json({
      error: "upstream_unreachable",
      message: `Gateway paid and verified, but the upstream API failed: ${(error as Error).message}`,
      target,
    });
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  res.setHeader("x-tollgate-gateway", gateway.id);
  res.setHeader("x-tollgate-paid", "true");
  if (settled?.signature) {
    res.setHeader("x-tollgate-signature", settled.signature);
    res.setHeader("x-tollgate-explorer", explorerTx(settled.signature));
    res.setHeader("x-tollgate-amount-lamports", String(settled.priceLamports));
  }
  res.send(buffer);
}

export { PAYMENT_HEADER };
