/**
 * agent-pay.ts — a minimal paying agent.
 *
 * Give it any Tollgate-metered URL. It calls the endpoint, reads the 402 challenge,
 * settles the invoice on Solana and replays the request with the payment reference.
 *
 *   npx tsx scripts/agent-pay.ts http://127.0.0.1:8099/g/gw_xxx/network-report
 *
 * Env:
 *   AGENT_KEYPAIR   path to a JSON keypair file (default ./.data/agent-payer.json)
 *   AGENT_RPC       RPC endpoint (default devnet)
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { buildPaymentTransaction } from "../src/solana.js";

const RPC = process.env.AGENT_RPC ?? "https://api.devnet.solana.com";
const KEYPAIR_FILE = process.env.AGENT_KEYPAIR ?? "./.data/agent-payer.json";
const PAYMENT_HEADER = "x-tollgate-payment";

function log(step: string, msg: string): void {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}

function loadAgentWallet(): Keypair {
  fs.mkdirSync(path.dirname(KEYPAIR_FILE), { recursive: true });
  if (fs.existsSync(KEYPAIR_FILE)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npx tsx scripts/agent-pay.ts <metered-url>");
    process.exit(1);
  }

  const connection = new Connection(RPC, "confirmed");
  const wallet = loadAgentWallet();
  log("wallet", `${wallet.publicKey.toBase58()} (${RPC})`);

  log("call", `GET ${target}`);
  const first = await fetch(target);
  log("call", `← HTTP ${first.status} ${first.headers.get("content-type") ?? ""}`);

  if (first.status !== 402) {
    console.log(await first.text());
    return;
  }

  const challenge = (await first.json()) as any;
  log("challenge", `price ${challenge.priceSol} SOL → ${challenge.recipient} (${challenge.network})`);
  log("challenge", `reference ${challenge.reference}`);

  let balance = await connection.getBalance(wallet.publicKey);
  if (balance < challenge.priceLamports * 2) {
    log("faucet", `balance ${balance / LAMPORTS_PER_SOL} SOL — requesting devnet airdrop`);
    const sig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    balance = await connection.getBalance(wallet.publicKey);
  }
  log("balance", `${balance / LAMPORTS_PER_SOL} SOL`);

  const tx = buildPaymentTransaction({
    payer: wallet.publicKey,
    recipient: new PublicKey(challenge.recipient),
    amountLamports: challenge.priceLamports,
    reference: new PublicKey(challenge.reference),
    memo: challenge.memo,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  log("settle", `submitted ${signature}`);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  log("settle", `confirmed — https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  log("replay", `GET ${target}  (${PAYMENT_HEADER}: ${challenge.reference})`);
  const paid = await fetch(target, { headers: { [PAYMENT_HEADER]: challenge.reference } });
  log("replay", `← HTTP ${paid.status} · gateway receipt ${paid.headers.get("x-tollgate-signature")}`);
  console.log(await paid.text());
}

main().catch((error) => {
  console.error("agent failed:", (error as Error).message);
  process.exit(1);
});
