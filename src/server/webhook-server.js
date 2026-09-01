const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { diagnose } = require("../core/diagnose");
const { gate } = require("../core/policy-gate");
const { executeAction } = require("../core/action-executor");

const app = express();

app.use((req, res, next) => {
  console.log(`\n>>> RAW HIT: ${req.method} ${req.url} at ${new Date().toISOString()}`);
  console.log(`>>> Headers: ${JSON.stringify(req.headers)}`);
  next();
});

app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

app.use((err, req, res, next) => {
  if (err) {
    console.log(`>>> JSON PARSE ERROR: ${err.message}`);
    return res.status(400).send("Bad request body");
  }
  next();
});

const WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || "test_secret_change_me";
const AUDIT_LOG_FILE = path.join(__dirname, "..", "..", "logs", "audit-log.jsonl");
const attemptHistory = {};


function verifySignature(rawBody, signatureHeader) {
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return expected === signatureHeader;
}

function appendAuditEntry(entry) {
  fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
}

function normalizeFailedPayment(payload) {
  const p = payload.payment.entity;
  const orderNotes = payload.order ? payload.order.entity.notes : (p.notes || {});
  return {
    event_id: `evt_real_${p.id}`,
    type: "payment.failed",
    customer_id: p.customer_id || p.contact || "unknown",
    amount: p.amount,
    currency: p.currency,
    error_code: p.error_reason || p.error_code,
    error_description: p.error_description,
    timestamp: new Date(p.created_at * 1000).toISOString(),
    attempt_number: 1,
    source: "real_test_mode",
    razorpay_payment_id: p.id,
    customer_contact: orderNotes.customer_contact || p.contact,
    customer_email: orderNotes.customer_email || p.email,
  };
}

function normalizeSubscriptionPending(payload) {
  const s = payload.subscription.entity;
  const p = payload.payment ? payload.payment.entity : {};
  return {
    event_id: `evt_real_subpending_${s.id}_${s.paid_count}`,
    type: "subscription.charge.failed",
    customer_id: s.customer_id || "unknown",
    subscription_id: s.id,
    amount: p.amount || s.plan_id_amount || 0,
    currency: p.currency || "INR",
    error_code: p.error_reason || "gateway_technical_error",
    timestamp: new Date().toISOString(),
    attempt_number: (s.total_count || 0) - (s.remaining_count || 0),
    source: "real_test_mode",
  };
}

function normalizeSubscriptionHalted(payload) {
  const s = payload.subscription.entity;
  return {
    event_id: `evt_real_subhalted_${s.id}`,
    type: "subscription.halted",
    customer_id: s.customer_id || "unknown",
    subscription_id: s.id,
    amount: s.plan_id_amount || 0,
    currency: "INR",
    timestamp: new Date().toISOString(),
    attempt_number: 1,
    source: "real_test_mode",
  };
}

async function runPipeline(event) {
  console.log(`  >>> runPipeline started for ${event.event_id} (type: ${event.type}, error_code: ${event.error_code})`);
  const diagnosis = diagnose(event);
  console.log(`  >>> Diagnosed as: ${diagnosis.bucket} (confidence ${diagnosis.confidence})`);
  const decision = gate(event, diagnosis, attemptHistory);
  console.log(`  >>> Gate decision: ${decision.decision} - ${decision.reason}`);
  attemptHistory[event.event_id] = (attemptHistory[event.event_id] || 0) + 1;

  const baseEntry = {
    timestamp: new Date().toISOString(),
    event_id: event.event_id,
    type: event.type,
    customer_id: event.customer_id,
    amount: event.amount,
    error_code: event.error_code,
    source: event.source || "synthetic",
    diagnosis_bucket: diagnosis.bucket,
    diagnosis_confidence: diagnosis.confidence,
    gate_decision: decision.decision,
    gate_reason: decision.reason,
  };

  if (decision.decision === "ESCALATE") {
    const entry = { ...baseEntry, actor: "human_queue", action_taken: "NONE", outcome: "ESCALATED" };
    appendAuditEntry(entry);
    return entry;
  }

  const result = await executeAction(event, decision.action);
  const entry = { ...baseEntry, actor: "agent", action_taken: decision.action, outcome: result.status, outcome_detail: result.detail };
  appendAuditEntry(entry);
  return entry;
}

function markRecovered(originalEventId, razorpayPaymentId) {
  appendAuditEntry({
    timestamp: new Date().toISOString(),
    event_id: originalEventId,
    type: "recovery.confirmed",
    actor: "razorpay_webhook",
    action_taken: "NONE",
    outcome: "SUCCESS",
    outcome_detail: `Confirmed paid via ${razorpayPaymentId}`,
  });
}

app.post("/webhook", async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] Incoming webhook request`);
  console.log(`  Event: ${req.body && req.body.event}`);

  const signature = req.headers["x-razorpay-signature"];
  if (!signature) {
    console.log("  REJECTED: no x-razorpay-signature header present");
    return res.status(400).send("Missing signature");
  }
  if (!verifySignature(req.rawBody, signature)) {
    console.log("  REJECTED: signature verification failed - check RZP_WEBHOOK_SECRET matches the dashboard exactly");
    return res.status(400).send("Invalid signature");
  }
  console.log("  Signature verified OK");

  const { event, payload } = req.body;
  res.sendStatus(200);

  try {
    if (event === "payment.failed") {
      const normalized = normalizeFailedPayment(payload);
      await runPipeline(normalized);
    } else if (event === "subscription.pending") {
      const normalized = normalizeSubscriptionPending(payload);
      await runPipeline(normalized);
    } else if (event === "subscription.halted") {
      const normalized = normalizeSubscriptionHalted(payload);
      await runPipeline(normalized);
    } else if (event === "payment_link.paid" || event === "payment.captured" || event === "order.paid") {
      const p = payload.payment ? payload.payment.entity : payload.order.entity;
      const originalEventId =
        (p.notes && p.notes.original_event) ||
        (payload.order && payload.order.entity.notes && payload.order.entity.notes.original_event) ||
        (payload.payment_link && payload.payment_link.entity.notes && payload.payment_link.entity.notes.original_event) ||
        (payload.payment_link && payload.payment_link.entity.reference_id) ||
        p.reference_id;
      console.log(`  >>> Recovery match check: originalEventId=${originalEventId || "NONE FOUND"}`);
      if (originalEventId) markRecovered(originalEventId, p.id);
    } else if (event === "payment_link.expired" || event === "payment_link.cancelled") {
      const link = payload.payment_link.entity;
      const originalEventId = (link.notes && link.notes.original_event) || link.reference_id;
      if (originalEventId) {
        appendAuditEntry({
          timestamp: new Date().toISOString(),
          event_id: originalEventId,
          type: "recovery.link_unclaimed",
          actor: "razorpay_webhook",
          action_taken: "NONE",
          outcome: "FAILED",
          outcome_detail: `Payment link ${event === "payment_link.expired" ? "expired" : "was cancelled"} without payment`,
        });
      }
    } else if (event === "payment.downtime.started" || event === "payment.downtime.updated") {
      appendAuditEntry({
        timestamp: new Date().toISOString(),
        type: "payment_method_degradation",
        actor: "razorpay_webhook",
        outcome: "INFO",
        outcome_detail: JSON.stringify(payload.payment_downtime ? payload.payment_downtime.entity : payload),
      });
    }
  } catch (err) {
    appendAuditEntry({
      timestamp: new Date().toISOString(),
      type: "pipeline.error",
      error: err.message,
      raw_event: event,
    });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Webhook receiver listening on :${PORT}/webhook`));
}

process.on("unhandledRejection", (reason) => {
  console.log(`\n!!! UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  console.log(`\n!!! UNCAUGHT EXCEPTION: ${err.stack}`);
});

module.exports = { app, normalizeFailedPayment, normalizeSubscriptionPending, normalizeSubscriptionHalted, runPipeline };
