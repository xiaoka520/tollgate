import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, INVOICE_TTL_SECONDS } from "./config.js";

export interface Gateway {
  id: string;
  name: string;
  /** Base URL of the upstream API that gets proxied once payment settles. */
  upstream: string;
  priceLamports: number;
  /** Solana address that receives the per-call payment. */
  recipient: string;
  createdAt: string;
  calls: number;
  revenueLamports: number;
  /** Path prefix the caller uses, e.g. /g/<id>. */
  path: string;
}

export interface Invoice {
  /** Unique Solana public key used as the payment reference for this call. */
  reference: string;
  gatewayId: string;
  method: string;
  path: string;
  priceLamports: number;
  recipient: string;
  status: "pending" | "paid" | "expired";
  signature: string | null;
  payer: string | null;
  paidAt: string | null;
  createdAt: string;
  expiresAt: string;
}

interface DB {
  gateways: Gateway[];
  invoices: Invoice[];
}

const DB_FILE = path.join(DATA_DIR, "db.json");

function load(): DB {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as DB;
    return { gateways: parsed.gateways ?? [], invoices: parsed.invoices ?? [] };
  } catch {
    return { gateways: [], invoices: [] };
  }
}

const db: DB = load();

function persist(): void {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export const store = {
  listGateways(): Gateway[] {
    return [...db.gateways].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  getGateway(id: string): Gateway | undefined {
    return db.gateways.find((g) => g.id === id);
  },

  createGateway(input: {
    name: string;
    upstream: string;
    priceLamports: number;
    recipient: string;
  }): Gateway {
    const id = shortId("gw");
    const gw: Gateway = {
      id,
      name: input.name,
      upstream: input.upstream.replace(/\/$/, ""),
      priceLamports: input.priceLamports,
      recipient: input.recipient,
      createdAt: new Date().toISOString(),
      calls: 0,
      revenueLamports: 0,
      path: `/g/${id}`,
    };
    db.gateways.push(gw);
    persist();
    return gw;
  },

  createInvoice(input: {
    reference: string;
    gateway: Gateway;
    method: string;
    path: string;
  }): Invoice {
    const now = Date.now();
    const inv: Invoice = {
      reference: input.reference,
      gatewayId: input.gateway.id,
      method: input.method,
      path: input.path,
      priceLamports: input.gateway.priceLamports,
      recipient: input.gateway.recipient,
      status: "pending",
      signature: null,
      payer: null,
      paidAt: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVOICE_TTL_SECONDS * 1000).toISOString(),
    };
    db.invoices.push(inv);
    if (db.invoices.length > 5000) db.invoices.splice(0, db.invoices.length - 5000);
    persist();
    return inv;
  },

  getInvoice(reference: string): Invoice | undefined {
    return db.invoices.find((i) => i.reference === reference);
  },

  findInvoiceBySignature(signature: string): Invoice | undefined {
    return db.invoices.find((i) => i.signature === signature);
  },

  markPaid(reference: string, signature: string, payer: string | null): Invoice | undefined {
    const inv = this.getInvoice(reference);
    if (!inv) return undefined;
    if (inv.status === "paid") return inv;
    inv.status = "paid";
    inv.signature = signature;
    inv.payer = payer;
    inv.paidAt = new Date().toISOString();
    const gw = db.gateways.find((g) => g.id === inv.gatewayId);
    if (gw) {
      gw.calls += 1;
      gw.revenueLamports += inv.priceLamports;
    }
    persist();
    return inv;
  },

  expireStale(): number {
    let n = 0;
    const now = Date.now();
    for (const inv of db.invoices) {
      if (inv.status === "pending" && Date.parse(inv.expiresAt) < now) {
        inv.status = "expired";
        n += 1;
      }
    }
    if (n) persist();
    return n;
  },

  listInvoices(limit = 50): Invoice[] {
    return [...db.invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  },

  stats() {
    const paid = db.invoices.filter((i) => i.status === "paid");
    return {
      gateways: db.gateways.length,
      invoices: db.invoices.length,
      paidCalls: paid.length,
      pending: db.invoices.filter((i) => i.status === "pending").length,
      revenueLamports: paid.reduce((sum, i) => sum + i.priceLamports, 0),
    };
  },
};
