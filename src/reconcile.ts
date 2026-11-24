/**
 * Daily (or hourly) reconciliation: compare what we think happened with what
 * the money says happened, and list every line a person needs to look at.
 */
import type { LedgerStore, Order, Payment } from "./ledger.js";

export interface ReconciliationReport {
  totals: {
    orders: number;
    paidOrders: number;
    expectedKes: number;
    receivedKes: number;
  };
  /** Paid, but not the amount we asked for. */
  amountMismatches: { order: Order; received: number }[];
  /** More than one receipt for the same order. Refund candidates. */
  doublePayments: { order: Order; payments: Payment[] }[];
  /** Money with no order. Usually a lost order row or a callback for another system. */
  orphanPayments: Payment[];
  /** Still pending after the cut-off: the callback never came. Query Daraja for these. */
  stalePending: Order[];
}

export function reconcile(
  store: LedgerStore,
  options: { now?: Date; staleAfterMinutes?: number } = {},
): ReconciliationReport {
  const now = options.now ?? new Date();
  const staleMs = (options.staleAfterMinutes ?? 15) * 60_000;
  const orders = store.allOrders();
  const payments = store.allPayments();

  const report: ReconciliationReport = {
    totals: {
      orders: orders.length,
      paidOrders: orders.filter((o) => o.status === "paid").length,
      expectedKes: 0,
      receivedKes: payments.reduce((sum, p) => sum + p.amount, 0),
    },
    amountMismatches: [],
    doublePayments: [],
    orphanPayments: payments.filter((p) => p.orderId === null),
    stalePending: [],
  };

  for (const order of orders) {
    const paid = store.paymentsForOrder(order.id);
    if (paid.length > 0) report.totals.expectedKes += order.amount;

    if (paid.length > 1) report.doublePayments.push({ order, payments: paid });
    else if (paid.length === 1 && paid[0]!.amount !== order.amount) {
      report.amountMismatches.push({ order, received: paid[0]!.amount });
    }

    if (order.status === "pending" && now.getTime() - order.createdAt.getTime() > staleMs) {
      report.stalePending.push(order);
    }
  }
  return report;
}

export function isClean(report: ReconciliationReport): boolean {
  return (
    report.amountMismatches.length === 0 &&
    report.doublePayments.length === 0 &&
    report.orphanPayments.length === 0 &&
    report.stalePending.length === 0
  );
}
