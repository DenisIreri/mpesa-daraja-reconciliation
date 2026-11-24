/**
 * Tiny HTTP server (node:http, no framework) wiring the pieces together:
 *
 *   POST /pay                 { orderId, amount, phone }  -> starts an STK push
 *   POST /mpesa/callback?token=...                         -> Safaricom calls this
 *   GET  /reconcile                                        -> JSON reconciliation report
 *
 * Run with a filled-in .env:  npm start
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DarajaClient } from "./daraja.js";
import { CallbackError, parseStkCallback } from "./callback.js";
import { Ledger, MemoryStore } from "./ledger.js";
import { reconcile } from "./reconcile.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

const daraja = new DarajaClient({
  baseUrl: process.env.DARAJA_BASE_URL ?? "https://sandbox.safaricom.co.ke",
  consumerKey: requireEnv("DARAJA_CONSUMER_KEY"),
  consumerSecret: requireEnv("DARAJA_CONSUMER_SECRET"),
  shortcode: requireEnv("DARAJA_SHORTCODE"),
  passkey: requireEnv("DARAJA_PASSKEY"),
  callbackUrl: `${requireEnv("DARAJA_CALLBACK_URL")}?token=${encodeURIComponent(requireEnv("CALLBACK_TOKEN"))}`,
});
const callbackToken = Buffer.from(requireEnv("CALLBACK_TOKEN"));
const store = new MemoryStore();
const ledger = new Ledger(store);

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenMatches(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  return a.length === callbackToken.length && timingSafeEqual(a, callbackToken);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "POST" && url.pathname === "/pay") {
      const body = (await readJson(req)) as { orderId?: string; amount?: number; phone?: string };
      if (!body.orderId || typeof body.amount !== "number" || !body.phone) {
        return send(res, 400, { error: "orderId, amount and phone are required" });
      }
      const push = await daraja.stkPush({
        amount: body.amount,
        phone: body.phone,
        accountReference: body.orderId,
        description: "Order payment",
      });
      ledger.openOrder(body.orderId, body.amount, push.CheckoutRequestID);
      return send(res, 202, { checkoutRequestId: push.CheckoutRequestID, message: push.CustomerMessage });
    }

    if (req.method === "POST" && url.pathname === "/mpesa/callback") {
      if (!tokenMatches(url.searchParams.get("token"))) return send(res, 403, { error: "forbidden" });
      const outcome = ledger.apply(parseStkCallback(await readJson(req)));
      console.log("callback", outcome);
      // Acknowledge once the result is stored, so Safaricom stops retrying.
      return send(res, 200, { ResultCode: 0, ResultDesc: "Accepted" });
    }

    if (req.method === "GET" && url.pathname === "/reconcile") {
      return send(res, 200, reconcile(store));
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof CallbackError || err instanceof SyntaxError) {
      return send(res, 400, { error: err.message });
    }
    console.error(err);
    send(res, 500, { error: "internal error" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening on http://localhost:${port}`));
