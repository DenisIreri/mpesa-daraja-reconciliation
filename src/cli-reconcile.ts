/**
 * Offline demo: no Safaricom account needed. Replays a handful of realistic
 * callbacks (including the messy ones) and prints the reconciliation report.
 *
 *   npm run reconcile
 */
import { parseStkCallback } from "./callback.js";
import { Ledger, MemoryStore } from "./ledger.js";
import { isClean, reconcile } from "./reconcile.js";
import { failedCallback, paidCallback } from "../test/fixtures.js";

const start = new Date("2026-01-15T09:00:00Z");
let minutes = 0;
const clock = () => new Date(start.getTime() + minutes * 60_000);

const store = new MemoryStore();
const ledger = new Ledger(store, clock);

ledger.openOrder("ORD-1001", 1500, "ws_CO_1");
ledger.openOrder("ORD-1002", 800, "ws_CO_2");
ledger.openOrder("ORD-1003", 2300, "ws_CO_3");
ledger.openOrder("ORD-1004", 500, "ws_CO_4");
ledger.openOrder("ORD-1005", 1200, "ws_CO_5");

const events = [
  paidCallback("ws_CO_1", "SAB1C2D3E4", 1500), // normal payment
  paidCallback("ws_CO_1", "SAB1C2D3E4", 1500), // Safaricom retry of the same callback
  paidCallback("ws_CO_2", "SAB1C2D3E5", 700), // customer paid the wrong amount
  failedCallback("ws_CO_3", 1032, "Request cancelled by user"),
  paidCallback("ws_CO_4", "SAB1C2D3E6", 500),
  paidCallback("ws_CO_4", "SAB1C2D3E7", 500), // paid twice with two receipts
  paidCallback("ws_CO_99", "SAB1C2D3E8", 950), // money for an order we do not know
  // ORD-1005: callback never arrives
];

for (const event of events) {
  minutes += 1;
  console.log(ledger.apply(parseStkCallback(event)));
}

minutes = 60;
const report = reconcile(store, { now: clock(), staleAfterMinutes: 15 });
console.log("\nReconciliation report");
console.log(JSON.stringify(report, null, 2));
console.log(isClean(report) ? "\nClean." : "\nNeeds review: see the lists above.");
