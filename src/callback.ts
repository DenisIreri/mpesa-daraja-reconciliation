/**
 * Parse the STK Push result that Safaricom POSTs to your callback URL.
 *
 * The payload is loosely typed and the metadata is a list of {Name, Value} pairs,
 * so we validate by hand and turn it into one flat, typed result.
 */

export type StkResult =
  | {
      status: "paid";
      checkoutRequestId: string;
      merchantRequestId: string;
      receipt: string;
      amount: number;
      phone: string;
      /** Raw Daraja format YYYYMMDDHHmmss, Kenyan time. */
      transactionDate: string;
    }
  | {
      status: "failed";
      checkoutRequestId: string;
      merchantRequestId: string;
      resultCode: number;
      reason: string;
    };

interface RawItem {
  Name: string;
  Value?: string | number;
}

export class CallbackError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseStkCallback(payload: unknown): StkResult {
  const cb = isObject(payload) && isObject(payload.Body) ? payload.Body.stkCallback : undefined;
  if (!isObject(cb)) throw new CallbackError("Not an STK callback: missing Body.stkCallback");

  const checkoutRequestId = cb.CheckoutRequestID;
  const merchantRequestId = cb.MerchantRequestID;
  const resultCode = cb.ResultCode;
  if (typeof checkoutRequestId !== "string" || typeof merchantRequestId !== "string") {
    throw new CallbackError("Missing request IDs");
  }
  if (typeof resultCode !== "number") throw new CallbackError("Missing ResultCode");

  if (resultCode !== 0) {
    // e.g. 1032 = cancelled by user, 1037 = phone unreachable, 2001 = wrong PIN.
    return {
      status: "failed",
      checkoutRequestId,
      merchantRequestId,
      resultCode,
      reason: typeof cb.ResultDesc === "string" ? cb.ResultDesc : "Unknown",
    };
  }

  const items = isObject(cb.CallbackMetadata) ? cb.CallbackMetadata.Item : undefined;
  if (!Array.isArray(items)) throw new CallbackError("Successful callback without CallbackMetadata");
  const meta = new Map<string, string | number | undefined>(
    (items as RawItem[]).map((i) => [i.Name, i.Value]),
  );

  const amount = meta.get("Amount");
  const receipt = meta.get("MpesaReceiptNumber");
  const phone = meta.get("PhoneNumber");
  const date = meta.get("TransactionDate");
  if (typeof amount !== "number" || typeof receipt !== "string" || phone === undefined || date === undefined) {
    throw new CallbackError("Successful callback is missing Amount, receipt, phone or date");
  }

  return {
    status: "paid",
    checkoutRequestId,
    merchantRequestId,
    receipt,
    amount,
    phone: String(phone),
    transactionDate: String(date),
  };
}
