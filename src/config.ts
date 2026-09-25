import fs from "node:fs";
import path from "node:path";

export const NETWORK = process.env.TOLLGATE_NETWORK ?? "devnet";
export const RPC_URL = process.env.TOLLGATE_RPC_URL ?? "https://api.devnet.solana.com";
export const PORT = Number(process.env.PORT ?? 8099);
export const DATA_DIR = path.resolve(process.env.TOLLGATE_DATA_DIR ?? "./.data");
export const PUBLIC_BASE_URL = (process.env.TOLLGATE_PUBLIC_URL ?? "").replace(/\/$/, "");
export const DEFAULT_PRICE_LAMPORTS = Number(process.env.TOLLGATE_PRICE_LAMPORTS ?? 1_000_000);
export const INVOICE_TTL_SECONDS = Number(process.env.TOLLGATE_INVOICE_TTL ?? 900);
export const SOL = 1_000_000_000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Best-effort public base URL: explicit config wins, otherwise infer from the request. */
export function baseUrlFrom(req?: { protocol: string; get(name: string): string | undefined }): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  if (!req) return `http://localhost:${PORT}`;
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return host ? `${proto}://${host}` : `http://localhost:${PORT}`;
}
