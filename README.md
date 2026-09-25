# Tollgate

**Turn any HTTP API into an agent-payable API — per-call metering, settled on Solana.**

AI agents can now write code, but they still cannot pay for the APIs they call. Every metered
service on the internet is gated behind a human-shaped onboarding flow: sign up, verify an email,
get an API key, attach a credit card. Tollgate deletes all of it. Point Tollgate at an API you
already run and it becomes payable per call on Solana — no accounts, no keys, no subscriptions.

```
GET /g/<gateway>/your-endpoint
        │
        ├── no payment  → 402 Payment Required + a quoted Solana invoice
        │
        │   agent pays the quoted amount on chain, tagging the transfer with
        │   the invoice's reference account
        │
        └── retry with `x-tollgate-payment: <reference>`
                → Tollgate verifies the settlement on chain
                → proxies the call upstream
                → 200 + payload + receipt headers
```

Payment *is* authentication.

---

## Why this exists

- **Machine consumers have no credit cards.** The MCP/agent ecosystem is exploding, but the
  economics are stuck at "free tier or enterprise contract".
- **Subscriptions do not fit agent workloads.** An agent that needs 12 calls today and 4,000
  tomorrow does not want a monthly plan.
- **Existing pay-per-call protocols require the API owner to re-engineer their service.** With
  Tollgate the upstream keeps speaking plain HTTP. The paywall lives in the proxy.

## What makes it Solana-native

| Mechanism | Implementation |
|---|---|
| One invoice per call | Every unpaid request mints a throwaway `Keypair` whose public key becomes the payment **reference** |
| Reference-tagged settlement | The reference is attached to the transfer instruction as a read-only, non-signing account — the same trick Solana Pay uses |
| Verification, not trust | Tollgate walks `getSignaturesForAddress(reference)`, parses each transaction and asserts the recipient's lamport balance actually increased by the quoted price |
| Self-describing receipts | Each settlement carries a `tollgate:<gatewayId>` memo, so metering is auditable from any explorer |
| Idempotent delivery | A paid invoice is marked settled once; replays of the same reference reuse the stored settlement instead of re-verifying |

Settlement is confirmed with `commitment: "confirmed"`, so a `200` is only ever returned after the
cluster has accepted the transfer.

---

## Quick start

Requirements: **Node.js ≥ 20**, network access to a Solana RPC endpoint.

### With Docker (recommended)

```bash
git clone https://github.com/xiaoka520/tollgate.git
cd tollgate

docker compose up -d --build
# → http://localhost:8099
```

Wallets and invoice state persist in `./data`, which is generated on first boot. The image
ships a container healthcheck against `/api/health`.

### From source

```bash
git clone https://github.com/xiaoka520/tollgate.git
cd tollgate

npm install
cp .env.example .env      # optional — the defaults already target devnet

npm run build
npm start                 # → http://localhost:8099
```

Open <http://localhost:8099> and press **“Run the paying agent”**. The self-test walks the whole
loop against **Solana devnet** with a real on-chain transfer and prints an explorer link for the
settlement transaction.

> The built-in paying wallet needs a little devnet SOL. If the public faucet is rate limited,
> `GET /api/demo/funding` returns the address plus ready-made faucet links, and the dashboard shows
> a top-up prompt rather than failing silently. The repository also ships a
> `devnet-faucet` GitHub Actions workflow so CI can top the wallet up from a different source
> address:
>
> ```bash
> gh workflow run devnet-faucet -f address=<PUBKEY> -f lamports=1000000000
> ```

### Development

```bash
npm run dev               # tsx watch mode
npm run test:e2e          # full end-to-end assertions against a running instance
```

`npm run test:e2e` asserts the 402 challenge shape, the rejection of unknown references, a real
settlement on devnet, the verified passthrough, the receipt headers and the recorded revenue:

```
$ npx tsx test/e2e.ts http://127.0.0.1:8099
✓ gateway is online — network=devnet
✓ gateway created — gw_ba0d674d2e25
✓ unpaid call returns 402 — HTTP 402
✓ challenge quotes a price — 0.001 SOL
✓ challenge carries a reference
✓ challenge names the network — devnet
✓ unknown reference is rejected — HTTP 402
✓ self-test settled and proxied — 1.9 s
✓ self-test produced 5 steps
✓ settlement has an explorer link — 4xQ1…9f2
✓ upstream payload reached the payer — slot=… tps=…
✓ metered revenue was recorded — 1 paid calls
✓ invoice is marked paid with a signature
✓ invoice polling endpoint answers
```

---

## Using it

### 1. Meter your own API

```bash
curl -s -X POST http://localhost:8099/api/gateways \
  -H 'content-type: application/json' \
  -d '{"name":"My metered API","upstream":"https://api.example.com","priceSol":0.001}'
```

```json
{
  "gateway": { "id": "gw_1a2b3c4d5e6f", "priceLamports": 1000000, "recipient": "EMzp…KLft", "path": "/g/gw_1a2b3c4d5e6f" },
  "callUrl": "http://localhost:8099/g/gw_1a2b3c4d5e6f"
}
```

Everything under `/g/gw_1a2b3c4d5e6f/*` is now metered and proxied to `https://api.example.com/*`.

### 2. See the challenge

```bash
curl -i http://localhost:8099/g/gw_1a2b3c4d5e6f/any/path
```

```json
HTTP/1.1 402 Payment Required

{
  "error": "payment_required",
  "scheme": "solana-pay-reference",
  "network": "devnet",
  "priceLamports": 1000000,
  "priceSol": 0.001,
  "recipient": "EMzpDkHaNHXCH9nKMPcqPNPv26jGY4S2SUS4sbqJKLft",
  "reference": "PSRLfU5k5xkzSF5VwR5y8CNZ9E5NA3SBf7CsoWk6VRx",
  "memo": "tollgate:gw_1a2b3c4d5e6f",
  "expiresAt": "2026-09-25T10:56:24.275Z",
  "retryHeader": "x-tollgate-payment",
  "verifyUrl": "http://localhost:8099/api/invoices/PSRLfU5k…VRx",
  "howTo": [ "…", "…" ]
}
```

### 3. Let the agent pay

```bash
npx tsx scripts/agent-pay.ts "http://localhost:8099/g/gw_1a2b3c4d5e6f/network-report"
```

```
[wallet]    Hmz6YnjVvWt1yHpJ3sec8RGc5L3oqWYLRzfCMrcsBhAx (https://api.devnet.solana.com)
[call]      GET http://localhost:8099/g/gw_…/network-report
[call]      ← HTTP 402 application/json
[challenge] price 0.001 SOL → EMzp…KLft (devnet)
[challenge] reference PSRLfU5k5xkzSF5VwR5y8CNZ9E5NA3SBf7CsoWk6VRx
[settle]    submitted 4xQ1…9f2
[settle]    confirmed — https://explorer.solana.com/tx/4xQ1…9f2?cluster=devnet
[replay]    ← HTTP 200 · gateway receipt 4xQ1…9f2
{ "source": "solana-devnet", "slot": 412…, "avgTps": 1103.4, … }
```

Building the payment yourself? Attach the reference to the transfer instruction as a read-only
non-signer, add the memo, then replay the request with the reference in `x-tollgate-payment`.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness + active network |
| `GET` | `/api/config` | Network, RPC, merchant wallet, payment header |
| `GET` | `/api/gateways` | List gateways with lifetime calls and revenue |
| `POST` | `/api/gateways` | Register a gateway (`name`, `upstream`, `priceSol`/`priceLamports`, `recipient?`) |
| `GET` | `/api/gateways/:id` | One gateway |
| `GET` | `/api/invoices?limit=` | Invoices + aggregate stats |
| `GET` | `/api/invoices/:reference` | Poll a single invoice; re-verifies on chain while pending |
| `GET` | `/api/stats` | Aggregate metering stats |
| `GET` | `/api/demo/funding` | Built-in paying wallet balance + faucet links |
| `POST` | `/api/demo/run` | Full self-test: challenge → settle → verify → proxy |
| `*` | `/g/:gatewayId/*` | **The metered proxy** — 402 until settled |
| `GET` | `/sandbox/network-report` | Bundled upstream API: live devnet slot / epoch / TPS |
| `GET` | `/sandbox/priority-fees` | Bundled upstream API: recent prioritization fees |
| `POST` | `/sandbox/echo` | Bundled upstream API: echo (test metered writes) |

Responses proxied through a settled gateway carry receipt headers:

```
x-tollgate-paid: true
x-tollgate-signature: 4xQ1…9f2
x-tollgate-explorer: https://explorer.solana.com/tx/4xQ1…9f2?cluster=devnet
x-tollgate-amount-lamports: 1000000
```

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TOLLGATE_NETWORK` | `devnet` | Cluster label (`devnet` / `mainnet-beta`) |
| `TOLLGATE_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint |
| `PORT` | `8099` | HTTP port |
| `TOLLGATE_DATA_DIR` | `./.data` | Gateways, invoices and wallets (JSON) |
| `TOLLGATE_PUBLIC_URL` | *(inferred)* | Base URL used in quoted invoices behind a proxy |
| `TOLLGATE_PRICE_LAMPORTS` | `1000000` | Default price per call (0.001 SOL) |
| `TOLLGATE_INVOICE_TTL` | `900` | Invoice lifetime in seconds |

Wallets are generated on first boot into `TOLLGATE_DATA_DIR`: `merchant.json` receives the
metered revenue, `demo-payer.json` is the faucet-funded wallet the self-test spends from.

> The built-in paying wallet needs a little devnet SOL. If the faucet is rate limited,
> `GET /api/demo/funding` returns the address plus ready-made faucet links, and the UI shows a
> top-up prompt instead of failing silently.

---

## Running on mainnet

Set `TOLLGATE_NETWORK=mainnet-beta` and `TOLLGATE_RPC_URL` to a mainnet endpoint. No code changes
are required: invoice issuing, memo tagging, settlement verification and receipt headers are all
cluster-agnostic. For production you would want a dedicated merchant keypair (see
`TOLLGATE_DATA_DIR`) and a durable invoice store.

## Limits & honest scope

- Invoice and gateway state is a JSON file — right for a single node, not for a fleet.
- Verification scans the recent signatures that touched a reference; heavy traffic would want a
  webhook or indexer instead of polling.
- The paywall is per request, not per byte or per token. That is deliberate: it keeps the proxy
  streaming-agnostic.
- Devnet SOL has no value; this repository ships devnet defaults on purpose.

## Layout

```
src/
  config.ts    environment + public-URL inference
  store.ts     gateway/invoice persistence
  solana.ts    reference accounts, transaction building, on-chain verification, faucet top-up
  proxy.ts     the 402 gate and the verified reverse proxy
  index.ts     HTTP surface, sandbox upstream, self-test, static UI
public/
  index.html   dashboard + one-click paying-agent demo
scripts/
  agent-pay.ts reference paying agent (402 → settle → replay)
test/
  e2e.ts       end-to-end assertions against a live instance
```

## License

MIT
