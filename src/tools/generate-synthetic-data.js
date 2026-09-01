const fs = require("fs");
const path = require("path");
const { detectAbandonedCheckouts } = require("../detectors/abandonment-detector");
const { buildOverdueEvents } = require("../detectors/invoice-chaser");

const ERROR_DISTRIBUTION = [
  ["insufficient_funds", 22],
  ["payment_timed_out", 14],
  ["gateway_technical_error", 10],
  ["bank_technical_error", 8],
  ["card_declined", 12],
  ["payment_cancelled", 10],
  ["authentication_failed", 8],
  ["incorrect_cvv", 6],
  ["card_expired", 6],
  ["transaction_limit_exceeded", 4],
  ["card_not_enrolled", 3],
  ["debit_instrument_blocked", 2],
  ["payment_risk_check_failed", 2],
];

function weightedPick(dist) {
  const total = dist.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [val, w] of dist) {
    if (r < w) return val;
    r -= w;
  }
  return dist[0][0];
}

function randomAmount(minRupees = 99, maxRupees = 9999) {
  return Math.floor((minRupees + Math.random() * (maxRupees - minRupees)) * 100);
}

function pad(n, len) {
  return String(n).padStart(len, "0");
}

function randomPastTimestamp(maxDaysAgo) {
  return Date.now() - Math.floor(Math.random() * maxDaysAgo * 24 * 3600 * 1000);
}

function generateFailureEvents(count, type, idStart) {
  const events = [];
  for (let i = 0; i < count; i++) {
    const errorCode = weightedPick(ERROR_DISTRIBUTION);
    const base = {
      event_id: `evt_${pad(idStart + i, 5)}`,
      type,
      customer_id: `cust_${pad(1 + Math.floor(Math.random() * 40), 3)}`,
      amount: randomAmount(),
      currency: "INR",
      error_code: errorCode,
      error_description: `Simulated: ${errorCode.replace(/_/g, " ")}`,
      timestamp: new Date(randomPastTimestamp(7)).toISOString(),
      attempt_number: 1,
      source: "synthetic",
    };
    if (type === "subscription.charge.failed") {
      base.subscription_id = `sub_${pad(1 + Math.floor(Math.random() * 20), 3)}`;
    }
    events.push(base);
  }
  return events;
}

function generateAbandonmentEvents(orderCount, idStart) {
  const orders = [];
  const payments = [];
  for (let i = 0; i < orderCount; i++) {
    const id = `order_synth_${pad(idStart + i, 5)}`;
    orders.push({
      id,
      customer_id: `cust_${pad(1 + Math.floor(Math.random() * 40), 3)}`,
      amount: randomAmount(),
      currency: "INR",
      created_at: new Date(randomPastTimestamp(2)).toISOString(),
    });
    if (Math.random() < 0.55) {
      payments.push({ order_id: id, status: "captured" });
    }
  }
  return detectAbandonedCheckouts(orders, payments, Date.now());
}

function generateInvoiceEvents(invoiceCount, idStart) {
  const invoices = [];
  for (let i = 0; i < invoiceCount; i++) {
    const daysAgoIssued = 5 + Math.floor(Math.random() * 45);
    const dueOffsetDays = 7;
    const issuedAtSec = Math.floor((Date.now() - daysAgoIssued * 24 * 3600 * 1000) / 1000);
    invoices.push({
      id: `inv_synth_${pad(idStart + i, 5)}`,
      customer_id: `cust_b2b_${pad(1 + Math.floor(Math.random() * 15), 2)}`,
      status: "issued",
      amount_due: randomAmount(500, 50000),
      currency: "INR",
      issued_at: issuedAtSec,
      expire_by: issuedAtSec + dueOffsetDays * 24 * 3600,
    });
  }
  return buildOverdueEvents(invoices, Date.now());
}

function generateBatch({
  paymentCount = 60,
  subscriptionCount = 20,
  orderCountForAbandonment = 30,
  invoiceCount = 20,
  outFile,
} = {}) {
  let events = [];
  events = events.concat(generateFailureEvents(paymentCount, "payment.failed", 1));
  events = events.concat(generateFailureEvents(subscriptionCount, "subscription.charge.failed", paymentCount + 1));
  events = events.concat(generateAbandonmentEvents(orderCountForAbandonment, 1));
  events = events.concat(generateInvoiceEvents(invoiceCount, 1));

  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }

  const out = outFile || path.join(__dirname, "..", "..", "data", "synthetic-batch.json");
  fs.writeFileSync(out, JSON.stringify(events, null, 2));
  console.log(`Generated ${events.length} events across 4 loss types -> ${out}`);
  console.log(`  payment.failed: ${paymentCount}`);
  console.log(`  subscription.charge.failed: ${subscriptionCount}`);
  console.log(`  checkout.abandoned (from ${orderCountForAbandonment} orders): ${events.filter((e) => e.type === "checkout.abandoned").length}`);
  console.log(`  invoice.overdue (from ${invoiceCount} invoices): ${events.filter((e) => e.type === "invoice.overdue").length}`);
  return events;
}

if (require.main === module) {
  generateBatch();
}

module.exports = { generateBatch };
