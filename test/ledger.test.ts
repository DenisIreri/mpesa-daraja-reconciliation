import { describe, expect, it } from "vitest";
import { CallbackError, parseStkCallback } from "../src/callback.js";
import { Ledger, MemoryStore } from "../src/ledger.js";
import { isClean, reconcile } from "../src/reconcile.js";
import { failedCallback, paidCallback } from "./fixtures.js";

function setup() {
  let now = new Date("2026-01-15T09:00:00Z");
  const store = new MemoryStore();
  const ledger = new Ledger(store, () => now);
  return { store, ledger, advance: (min: number) => (now = new Date(now.getTime() + min * 60_000)) };
}

describe("parseStkCallback", () => {
  it("flattens a successful callback", () => {
    expect(parseStkCallback(paidCallback("ws_1", "SAB123", 1500))).toEqual({
      status: "paid",
      checkoutRequestId: "ws_1",
      merchantRequestId: "mr-ws_1",
      receipt: "SAB123",
      amount: 1500,
      phone: "254700000000",
      transactionDate: "20260115120501",
    });
  });

  it("returns a failure with the reason", () => {
    const r = parseStkCallback(failedCallback("ws_1", 1032, "Request cancelled by user"));
    expect(r).toMatchObject({ status: "failed", resultCode: 1032, reason: "Request cancelled by user" });
  });

  it("rejects payloads that are not STK callbacks", () => {
    expect(() => parseStkCallback({ hello: "world" })).toThrow(CallbackError);
    expect(() => parseStkCallback(null)).toThrow(CallbackError);
  });

  it("rejects a 'success' with no metadata", () => {
    const bad = paidCallback("ws_1", "SAB123", 10);
    delete (bad.Body.stkCallback as { CallbackMetadata?: unknown }).CallbackMetadata;
    expect(() => parseStkCallback(bad)).toThrow(CallbackError);
  });
});

describe("Ledger", () => {
  it("marks an order paid once, even when the callback is retried", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 1500, "ws_1");
    const cb = parseStkCallback(paidCallback("ws_1", "SAB123", 1500));

    expect(ledger.apply(cb)).toEqual({ kind: "paid", orderId: "A" });
    expect(ledger.apply(cb)).toEqual({ kind: "duplicate", receipt: "SAB123" });
    expect(store.allPayments()).toHaveLength(1);
    expect(store.getOrderByCheckout("ws_1")?.status).toBe("paid");
  });

  it("flags a wrong amount instead of accepting it", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 1500, "ws_1");
    expect(ledger.apply(parseStkCallback(paidCallback("ws_1", "SAB123", 1000)))).toEqual({
      kind: "amount_mismatch",
      orderId: "A",
      expected: 1500,
      received: 1000,
    });
    expect(store.getOrderByCheckout("ws_1")?.status).toBe("needs_review");
  });

  it("flags a second receipt for the same order as a double payment", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 500, "ws_1");
    ledger.apply(parseStkCallback(paidCallback("ws_1", "SAB1", 500)));
    expect(ledger.apply(parseStkCallback(paidCallback("ws_1", "SAB2", 500)))).toMatchObject({
      kind: "double_payment",
    });
    expect(store.paymentsForOrder("A")).toHaveLength(2);
  });

  it("keeps money for unknown orders as an orphan payment", () => {
    const { ledger, store } = setup();
    expect(ledger.apply(parseStkCallback(paidCallback("ws_x", "SAB9", 900)))).toEqual({
      kind: "orphan_payment",
      receipt: "SAB9",
    });
    expect(store.getPayment("SAB9")?.orderId).toBeNull();
  });

  it("never lets a late failure undo a payment", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 500, "ws_1");
    ledger.apply(parseStkCallback(paidCallback("ws_1", "SAB1", 500)));
    expect(ledger.apply(parseStkCallback(failedCallback("ws_1", 1037, "Timeout")))).toMatchObject({
      kind: "ignored_failure",
    });
    expect(store.getOrderByCheckout("ws_1")?.status).toBe("paid");
  });

  it("fails a pending order when the customer cancels", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 500, "ws_1");
    ledger.apply(parseStkCallback(failedCallback("ws_1", 1032, "Request cancelled by user")));
    expect(store.getOrderByCheckout("ws_1")).toMatchObject({
      status: "failed",
      failureReason: "Request cancelled by user",
    });
  });
});

describe("reconcile", () => {
  it("is clean when every order is paid the right amount", () => {
    const { ledger, store } = setup();
    ledger.openOrder("A", 500, "ws_1");
    ledger.apply(parseStkCallback(paidCallback("ws_1", "SAB1", 500)));
    const report = reconcile(store, { now: new Date("2026-01-15T10:00:00Z") });
    expect(isClean(report)).toBe(true);
    expect(report.totals).toEqual({ orders: 1, paidOrders: 1, expectedKes: 500, receivedKes: 500 });
  });

  it("lists every kind of problem", () => {
    const { ledger, store, advance } = setup();
    ledger.openOrder("mismatch", 1500, "ws_1");
    ledger.openOrder("double", 500, "ws_2");
    ledger.openOrder("stale", 800, "ws_3");
    ledger.apply(parseStkCallback(paidCallback("ws_1", "R1", 1000)));
    ledger.apply(parseStkCallback(paidCallback("ws_2", "R2", 500)));
    ledger.apply(parseStkCallback(paidCallback("ws_2", "R3", 500)));
    ledger.apply(parseStkCallback(paidCallback("ws_unknown", "R4", 300)));
    advance(30);

    const report = reconcile(store, { now: new Date("2026-01-15T09:30:00Z"), staleAfterMinutes: 15 });
    expect(report.amountMismatches.map((m) => m.order.id)).toEqual(["mismatch"]);
    expect(report.doublePayments.map((d) => d.order.id)).toEqual(["double"]);
    expect(report.orphanPayments.map((p) => p.receipt)).toEqual(["R4"]);
    expect(report.stalePending.map((o) => o.id)).toEqual(["stale"]);
    expect(report.totals.receivedKes).toBe(2300);
    expect(isClean(report)).toBe(false);
  });
});
