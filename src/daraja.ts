/**
 * Minimal Daraja (M-Pesa) client: OAuth token + STK Push (Lipa na M-Pesa Online).
 * Works against the sandbox by default. No SDK: just fetch, so every request is visible.
 */

export interface DarajaConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
}

export interface StkPushRequest {
  /** Whole shillings. M-Pesa does not accept cents. */
  amount: number;
  /** Customer phone in 2547XXXXXXXX or 2541XXXXXXXX form. */
  phone: string;
  /** Shown to the customer; we use the order reference. Max 12 chars. */
  accountReference: string;
  description: string;
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

type FetchLike = typeof fetch;

/** Daraja wants the timestamp in Kenyan time (EAT, UTC+3, no DST) as YYYYMMDDHHmmss. */
export function darajaTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    eat.getUTCFullYear().toString() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/** STK password = base64(shortcode + passkey + timestamp). */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(shortcode + passkey + timestamp).toString("base64");
}

/** Normalise 07XXXXXXXX / +2547XXXXXXXX / 2547XXXXXXXX to 2547XXXXXXXX. Throws on anything else. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[\s-]/g, "").replace(/^\+/, "");
  let msisdn = digits;
  if (/^0[17]\d{8}$/.test(digits)) msisdn = "254" + digits.slice(1);
  if (!/^254[17]\d{8}$/.test(msisdn)) {
    throw new Error("Phone number must be a Kenyan mobile number (07…, 01… or 254…)");
  }
  return msisdn;
}

export class DarajaClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: DarajaConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async accessToken(): Promise<string> {
    // Reuse the token until a minute before it expires (Daraja tokens last 3600 s).
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;

    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString("base64");
    const res = await this.fetchImpl(
      `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.ok) throw new Error(`Daraja OAuth failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: string };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    };
    return this.token.value;
  }

  async stkPush(req: StkPushRequest, now: Date = new Date()): Promise<StkPushResponse> {
    if (!Number.isInteger(req.amount) || req.amount < 1) {
      throw new Error("Amount must be a whole number of shillings, at least 1");
    }
    const phone = normalisePhone(req.phone);
    const timestamp = darajaTimestamp(now);
    const token = await this.accessToken();

    const res = await this.fetchImpl(`${this.config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: stkPassword(this.config.shortcode, this.config.passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: req.amount,
        PartyA: phone,
        PartyB: this.config.shortcode,
        PhoneNumber: phone,
        CallBackURL: this.config.callbackUrl,
        AccountReference: req.accountReference.slice(0, 12),
        TransactionDesc: req.description.slice(0, 13),
      }),
    });
    const body = (await res.json()) as StkPushResponse & { errorMessage?: string };
    if (!res.ok || body.ResponseCode !== "0") {
      throw new Error(`STK push rejected: ${body.errorMessage ?? body.ResponseDescription ?? res.status}`);
    }
    return body;
  }
}
