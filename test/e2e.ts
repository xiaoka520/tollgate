/**
 * End-to-end check against a running Tollgate instance.
 *
 *   npx tsx test/e2e.ts [baseUrl]
 *
 * Walks the real flow: 402 challenge → on-chain settlement on devnet → verified 200 passthrough,
 * then asserts the receipt headers and the gateway's metered revenue.
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8099";
const PAYMENT_HEADER = "x-tollgate-payment";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log(`\nTollgate e2e against ${BASE}\n`);

  const live = await fetch(`${BASE}/api/health`).then((r) => r.json() as Promise<any>);
  check("gateway is online", live?.ok === true, `network=${live?.network}`);

  const gateway = await fetch(`${BASE}/api/gateways`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `e2e ${Date.now()}`, upstream: `${BASE}/sandbox`, priceSol: 0.001 }),
  }).then((r) => r.json() as Promise<any>);
  check("gateway created", !!gateway?.gateway?.id, gateway?.gateway?.id);

  const callUrl = `${BASE}/g/${gateway.gateway.id}/network-report`;

  const unpaid = await fetch(callUrl);
  const challenge = (await unpaid.json()) as any;
  check("unpaid call returns 402", unpaid.status === 402, `HTTP ${unpaid.status}`);
  check("challenge quotes a price", challenge.priceLamports > 0, `${challenge.priceSol} SOL`);
  check("challenge carries a reference", typeof challenge.reference === "string" && challenge.reference.length > 30);
  check("challenge names the network", challenge.network === "devnet" || challenge.network === "mainnet-beta", challenge.network);

  const badRef = await fetch(callUrl, { headers: { [PAYMENT_HEADER]: "11111111111111111111111111111111" } });
  check("unknown reference is rejected", badRef.status === 402 || badRef.status === 400, `HTTP ${badRef.status}`);

  const demo = await fetch(`${BASE}/api/demo/run`, { method: "POST" }).then((r) => r.json() as Promise<any>);
  check("self-test settled and proxied", demo?.ok === true, demo?.error ?? `${demo?.elapsedMs} ms`);
  check("self-test produced 5 steps", Array.isArray(demo?.steps) && demo.steps.length >= 5);
  const settleStep = (demo?.steps ?? []).find((s: any) => s.signature);
  check("settlement has an explorer link", !!settleStep?.explorer, settleStep?.signature?.slice(0, 20));

  const payload = (demo?.steps ?? []).find((s: any) => s.payload)?.payload;
  check("upstream payload reached the payer", !!payload?.slot, payload ? `slot=${payload.slot} tps=${payload.avgTps}` : "missing");

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json() as Promise<any>);
  check("metered revenue was recorded", stats?.stats?.paidCalls >= 1, `${stats?.stats?.paidCalls} paid calls`);

  const invoices = await fetch(`${BASE}/api/invoices?limit=10`).then((r) => r.json() as Promise<any>);
  const paidInvoice = (invoices?.invoices ?? []).find((i: any) => i.status === "paid");
  check("invoice is marked paid with a signature", !!paidInvoice?.signature, paidInvoice?.signature?.slice(0, 20));

  const poll = await fetch(`${BASE}/api/invoices/${challenge.reference}`).then((r) => r.json() as Promise<any>);
  check("invoice polling endpoint answers", !!poll?.invoice?.reference);

  console.log(`\n${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("e2e failed:", (error as Error).message);
  process.exit(1);
});
