import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { DATA_DIR, NETWORK, RPC_URL, SOL } from "./config.js";

export const connection = new Connection(RPC_URL, "confirmed");

/** SPL Memo program — used so every metered call leaves a human-readable on-chain note. */
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function loadOrCreateKeypair(name: string): Keypair {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    const secret = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** Wallet that receives all metered payments (configurable later per gateway). */
export const merchantKeypair = loadOrCreateKeypair("merchant");
/** Faucet-funded wallet used by the built-in self-test so judges can try Tollgate with zero setup. */
export const demoPayerKeypair = loadOrCreateKeypair("demo-payer");

export function explorerTx(signature: string): string {
  const cluster = NETWORK === "mainnet-beta" ? "" : `?cluster=${NETWORK}`;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export function explorerAddress(address: string): string {
  const cluster = NETWORK === "mainnet-beta" ? "" : `?cluster=${NETWORK}`;
  return `https://explorer.solana.com/address/${address}${cluster}`;
}

/** A fresh Solana address handed to the caller as the payment reference for one call. */
export function createPaymentReference(): Keypair {
  return Keypair.generate();
}

/**
 * Build the transfer the caller must sign.
 *
 * The reference keypair is attached to the transfer instruction as a read-only,
 * non-signing account. That is exactly how Solana Pay tags a payment: the payer does not
 * need to know anything about our invoice id, and we can locate the settlement later with a
 * single `getSignaturesForAddress(reference)` call.
 */
export function buildPaymentTransaction(params: {
  payer: PublicKey;
  recipient: PublicKey;
  amountLamports: number;
  reference: PublicKey;
  memo?: string;
}): Transaction {
  const { payer, recipient, amountLamports, reference, memo } = params;

  const transfer = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: reference, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      // SystemProgram.transfer discriminator (u32 LE = 2)
      Buffer.from([2, 0, 0, 0]),
      Buffer.from(new BigUint64Array([BigInt(amountLamports)]).buffer),
    ]),
  });

  const tx = new Transaction().add(transfer);
  if (memo) {
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
        data: Buffer.from(memo, "utf8"),
      }),
    );
  }
  return tx;
}

export interface Settlement {
  paid: boolean;
  signature: string | null;
  payer: string | null;
  amountLamports: number;
  slot?: number;
}

/**
 * Verify on-chain that the invoice reference was paid.
 *
 * Walks the signatures that touched the reference key, parses the transaction and checks the
 * recipient's lamport balance actually increased by at least the quoted price.
 */
export async function verifySettlement(params: {
  reference: string;
  recipient: string;
  minLamports: number;
}): Promise<Settlement> {
  const { reference, recipient, minLamports } = params;
  const empty: Settlement = { paid: false, signature: null, payer: null, amountLamports: 0 };

  let referenceKey: PublicKey;
  try {
    referenceKey = new PublicKey(reference);
  } catch {
    return empty;
  }

  const signatures = await connection.getSignaturesForAddress(referenceKey, { limit: 20 });
  for (const entry of signatures) {
    if (entry.err) continue;
    const tx = await connection.getParsedTransaction(entry.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.meta) continue;

    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const index = keys.indexOf(recipient);
    if (index < 0) continue;

    const delta = tx.meta.postBalances[index] - tx.meta.preBalances[index];
    if (delta >= minLamports) {
      return {
        paid: true,
        signature: entry.signature,
        payer: tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? null,
        amountLamports: delta,
        slot: tx.slot,
      };
    }
  }
  return empty;
}

/**
 * Top the given wallet up when it is running low.
 *
 * Order of preference:
 *   1. the devnet faucet (cheap, but heavily rate limited),
 *   2. a transfer from a sponsor wallet that has already collected metered revenue
 *      (this is what keeps a long-lived demo self-sustaining),
 *   3. give up and report clearly, so the caller can show a top-up prompt instead of a
 *      confusing simulation error.
 */
export async function ensureFunded(
  keypair: Keypair,
  minSol = 0.05,
  sponsor?: { keypair: Keypair; keepSol?: number },
): Promise<{ balanceSol: number; funded: boolean; source: string; address: string; note?: string }> {
  const balance = await connection.getBalance(keypair.publicKey);
  const address = keypair.publicKey.toBase58();
  if (balance >= minSol * LAMPORTS_PER_SOL) {
    return { balanceSol: balance / SOL, funded: true, source: "existing", address };
  }

  const notes: string[] = [];

  if (NETWORK === "devnet") {
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      const after = await connection.getBalance(keypair.publicKey);
      if (after >= minSol * LAMPORTS_PER_SOL) {
        return { balanceSol: after / SOL, funded: true, source: "faucet", address };
      }
    } catch (error) {
      notes.push(`faucet: ${(error as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  } else {
    notes.push("faucet unavailable outside devnet");
  }

  if (sponsor) {
    const keep = (sponsor.keepSol ?? 0.2) * LAMPORTS_PER_SOL;
    const sponsorBalance = await connection.getBalance(sponsor.keypair.publicKey);
    const spendable = sponsorBalance - keep;
    const want = Math.round(minSol * LAMPORTS_PER_SOL);
    if (spendable > want) {
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: sponsor.keypair.publicKey,
            toPubkey: keypair.publicKey,
            lamports: want,
          }),
        );
        const latest = await connection.getLatestBlockhash();
        tx.recentBlockhash = latest.blockhash;
        tx.feePayer = sponsor.keypair.publicKey;
        const sig = await sendAndConfirmTransaction(connection, tx, [sponsor.keypair], {
          commitment: "confirmed",
        });
        const after = await connection.getBalance(keypair.publicKey);
        return { balanceSol: after / SOL, funded: true, source: `sponsor:${sig.slice(0, 12)}`, address };
      } catch (error) {
        notes.push(`sponsor top-up: ${(error as Error).message.split("\n")[0].slice(0, 120)}`);
      }
    } else {
      notes.push("sponsor wallet has no surplus to lend");
    }
  }

  return {
    balanceSol: balance / SOL,
    funded: false,
    source: "none",
    address,
    note: notes.join(" · ") || "no funding source available",
  };
}

/**
 * Wait for a signature to reach at least `confirmed`, by polling status.
 *
 * `sendAndConfirmTransaction` gives up the moment its own websocket/timeout budget runs out —
 * on a congested devnet that happens *after* the transfer has already been accepted, which
 * makes a perfectly good settlement look like a failure. Polling the status endpoint is
 * resilient to that and also finds transactions that landed from an earlier attempt.
 */
async function confirmSignature(signature: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = value[0];
      if (status?.err) return false;
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return true;
      }
    } catch {
      /* transient RPC hiccup — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

/**
 * Sign and send the metered payment, retrying with a fresh blockhash.
 *
 * Used by the built-in self-test. Returns the first signature that actually confirmed, so the
 * receipt the caller sees always points at a transaction the cluster accepted.
 */
export async function payInvoice(params: {
  payer: Keypair;
  recipient: string;
  amountLamports: number;
  reference: string;
  memo?: string;
}): Promise<string> {
  const recipient = new PublicKey(params.recipient);
  const reference = new PublicKey(params.reference);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tx = buildPaymentTransaction({
      payer: params.payer.publicKey,
      recipient,
      amountLamports: params.amountLamports,
      reference,
      memo: params.memo,
    });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = params.payer.publicKey;
    tx.sign(params.payer);

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });
    } catch (error) {
      lastError = error as Error;
      continue;
    }

    if (await confirmSignature(signature, 45_000)) return signature;
    lastError = new Error(`transaction ${signature} was not confirmed within 45s`);
  }

  throw lastError ?? new Error("payment could not be settled");
}
