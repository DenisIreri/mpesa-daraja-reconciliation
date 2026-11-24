/**
 * Orders and payments, with the rules that keep the books right:
 *
 * - A payment is recorded once per M-Pesa receipt. Safaricom retries callbacks,
 *   so the same receipt arriving twice must not credit the order twice.
 * - A payment is tied to an order by the CheckoutRequestID we stored when we
 *   started the STK push, never by amount or phone (both are ambiguous).
 * - Anything that does not line up is kept and flagged for a person to review,
 *   never silently dropped or "fixed".
 *
 * Storage is in memory so the example runs anywhere; the `LedgerStore` interface
 * is the seam where Postgres (with a UNIQUE constraint on receipt) would go.
 */
import type { StkResult } from "./callback.js";

export type OrderStatus = "pending" | "paid" | "failed" | "needs_review";

export interface Order {
  id: string;
  /** Whole shillings. */
  amount: number;
  checkoutRequestId: string;
  status: OrderStatus;
  createdAt: Date;
  failureReason?: string;
}

export interface Payment {
  receipt: string;
  checkoutRequestId: string;
  amount: number;
  phone: string;
  transactionDate: string;
  /** Order this payment was matched to, or null if no order had that CheckoutRequestID. */
  orderId: string | null;
  receivedAt: Date;
}

export type ApplyOutcome =
  | { kind: "paid"; orderId: string }
  | { kind: "duplicate"; receipt: string }
  | { kind: "amount_mismatch"; orderId: string; expected: number; received: number }
  | { kind: "double_payment"; orderId: string; receipt: string }
  | { kind: "orphan_payment"; receipt: string }
  | { kind: "failed"; orderId: string }
  | { kind: "ignored_failure"; checkoutRequestId: string };

export interface LedgerStore {
  getOrderByCheckout(checkoutRequestId: string): Order | undefined;
  saveOrder(order: Order): void;
  getPayment(receipt: string): Payment | undefined;
  savePayment(payment: Payment): void;
  paymentsForOrder(orderId: string): Payment[];
  allOrders(): Order[];
  allPayments(): Payment[];
}

export class MemoryStore implements LedgerStore {
  private orders = new Map<string, Order>();
  private payments = new Map<string, Payment>();

  getOrderByCheckout(checkoutRequestId: string) {
    return [...this.orders.values()].find((o) => o.checkoutRequestId === checkoutRequestId);
  }
  saveOrder(order: Order) {
    this.orders.set(order.id, { ...order });
  }
  getPayment(receipt: string) {
    return this.payments.get(receipt);
  }
  savePayment(payment: Payment) {
    if (this.payments.has(payment.receipt)) throw new Error(`Duplicate receipt ${payment.receipt}`);
    this.payments.set(payment.receipt, { ...payment });
  }
  paymentsForOrder(orderId: string) {
    return [...this.payments.values()].filter((p) => p.orderId === orderId);
  }
  allOrders() {
    return [...this.orders.values()];
  }
  allPayments() {
    return [...this.payments.values()];
  }
}

export class Ledger {
  constructor(
    private readonly store: LedgerStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Call after a successful STK push, so the callback can find the order. */
  openOrder(id: string, amount: number, checkoutRequestId: string): Order {
    const order: Order = { id, amount, checkoutRequestId, status: "pending", createdAt: this.clock() };
    this.store.saveOrder(order);
    return order;
  }

  /** Apply one parsed callback. Safe to call any number of times with the same payload. */
  apply(result: StkResult): ApplyOutcome {
    const order = this.store.getOrderByCheckout(result.checkoutRequestId);

    if (result.status === "failed") {
      // Only a pending order can fail. A late "failed" must never undo a payment.
      if (!order || order.status !== "pending") {
        return { kind: "ignored_failure", checkoutRequestId: result.checkoutRequestId };
      }
      this.store.saveOrder({ ...order, status: "failed", failureReason: result.reason });
      return { kind: "failed", orderId: order.id };
    }

    if (this.store.getPayment(result.receipt)) return { kind: "duplicate", receipt: result.receipt };

    const alreadyPaid = order ? this.store.paymentsForOrder(order.id).length > 0 : false;
    this.store.savePayment({
      receipt: result.receipt,
      checkoutRequestId: result.checkoutRequestId,
      amount: result.amount,
      phone: result.phone,
      transactionDate: result.transactionDate,
      orderId: order?.id ?? null,
      receivedAt: this.clock(),
    });

    if (!order) return { kind: "orphan_payment", receipt: result.receipt };

    if (alreadyPaid) {
      this.store.saveOrder({ ...order, status: "needs_review" });
      return { kind: "double_payment", orderId: order.id, receipt: result.receipt };
    }
    if (result.amount !== order.amount) {
      this.store.saveOrder({ ...order, status: "needs_review" });
      return { kind: "amount_mismatch", orderId: order.id, expected: order.amount, received: result.amount };
    }
    this.store.saveOrder({ ...order, status: "paid" });
    return { kind: "paid", orderId: order.id };
  }
}
