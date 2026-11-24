import { describe, expect, it, vi } from "vitest";
import { DarajaClient, darajaTimestamp, normalisePhone, stkPassword } from "../src/daraja.js";

const config = {
  baseUrl: "https://sandbox.example",
  consumerKey: "key",
  consumerSecret: "secret",
  shortcode: "174379",
  passkey: "passkey",
  callbackUrl: "https://example.test/cb",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("helpers", () => {
  it("formats the timestamp in Kenyan time", () => {
    // 21:30 UTC is 00:30 the next day in Nairobi.
    expect(darajaTimestamp(new Date("2026-01-15T21:30:05Z"))).toBe("20260116003005");
  });

  it("builds the STK password", () => {
    expect(stkPassword("174379", "pk", "20260101000000")).toBe(
      Buffer.from("174379pk20260101000000").toString("base64"),
    );
  });

  it.each([
    ["0712345678", "254712345678"],
    ["+254 712 345 678", "254712345678"],
    ["0112345678", "254112345678"],
    ["254712345678", "254712345678"],
  ])("normalises %s", (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it.each(["12345", "0812345678", "2557123456789"])("rejects %s", (input) => {
    expect(() => normalisePhone(input)).toThrow();
  });
});

describe("DarajaClient", () => {
  it("fetches a token once and sends a correct STK push", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: "3599" }))
      .mockImplementation(async () =>
        json({
          MerchantRequestID: "m1",
          CheckoutRequestID: "ws_1",
          ResponseCode: "0",
          ResponseDescription: "Success",
          CustomerMessage: "Success",
        }),
      );
    const client = new DarajaClient(config, fetchMock);
    const now = new Date("2026-01-15T09:00:00Z");

    await client.stkPush({ amount: 100, phone: "0712345678", accountReference: "ORD-1", description: "Test" }, now);
    await client.stkPush({ amount: 100, phone: "0712345678", accountReference: "ORD-2", description: "Test" }, now);

    expect(fetchMock).toHaveBeenCalledTimes(3); // one token + two pushes
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://sandbox.example/mpesa/stkpush/v1/processrequest");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      BusinessShortCode: "174379",
      Timestamp: "20260115120000",
      Amount: 100,
      PartyA: "254712345678",
      PhoneNumber: "254712345678",
      CallBackURL: "https://example.test/cb",
      AccountReference: "ORD-1",
    });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("refuses fractional amounts before calling Safaricom", async () => {
    const fetchMock = vi.fn();
    const client = new DarajaClient(config, fetchMock);
    await expect(
      client.stkPush({ amount: 99.5, phone: "0712345678", accountReference: "A", description: "x" }),
    ).rejects.toThrow(/whole number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Daraja's error message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "tok", expires_in: "3599" }))
      .mockResolvedValueOnce(json({ errorMessage: "Invalid PhoneNumber" }, 400));
    const client = new DarajaClient(config, fetchMock);
    await expect(
      client.stkPush({ amount: 10, phone: "0712345678", accountReference: "A", description: "x" }),
    ).rejects.toThrow("Invalid PhoneNumber");
  });
});
