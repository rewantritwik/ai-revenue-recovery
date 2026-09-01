

const { BUCKET_POLICY, GLOBAL_CAPS } = require("./config");


const customerActionCounts = {};

function gate(event, diagnosis, attemptHistory = {}) {
  const { bucket, confidence } = diagnosis;
  const priorAttempts = attemptHistory[event.event_id] || 0;


  if (confidence < 0.5 || bucket === "UNKNOWN") {
    return {
      decision: "ESCALATE",
      reason: "Low diagnosis confidence - routed to human review",
    };
  }

  const policy = BUCKET_POLICY[bucket];


  if (bucket === "FRAUD_FLAG") {
    return {
      decision: "ESCALATE",
      reason: "Fraud-risk signal - defense-only policy forbids auto-action",
    };
  }


  if (event.type === "invoice.overdue" && (event.days_overdue ?? 0) > GLOBAL_CAPS.maxInvoiceChaseDays) {
    return {
      decision: "ESCALATE",
      reason: `Invoice ${event.days_overdue} days overdue exceeds compliant auto-chase window (${GLOBAL_CAPS.maxInvoiceChaseDays} days) - human/collections handoff required`,
    };
  }

  if (priorAttempts >= GLOBAL_CAPS.maxRetriesPerEvent) {
    return {
      decision: "ESCALATE",
      reason: `Exceeded global max retries (${GLOBAL_CAPS.maxRetriesPerEvent}) - stopping rule triggered`,
    };
  }

  if (priorAttempts >= policy.maxAttempts) {
    return {
      decision: "ESCALATE",
      reason: `Exceeded bucket-specific max attempts (${policy.maxAttempts}) for ${bucket}`,
    };
  }

  const cap = Math.min(policy.maxAmountForAutoAction, GLOBAL_CAPS.maxAutoActionAmountPaise);
  if (event.amount > cap) {
    return {
      decision: "ESCALATE",
      reason: `Amount ₹${(event.amount / 100).toFixed(2)} exceeds auto-action cap of ₹${(cap / 100).toFixed(2)}`,
    };
  }

  const custCount = customerActionCounts[event.customer_id] || 0;
  if (custCount >= GLOBAL_CAPS.maxActionsPerCustomerPerDay) {
    return {
      decision: "ESCALATE",
      reason: "Per-customer daily action cap reached",
    };
  }
  customerActionCounts[event.customer_id] = custCount + 1;

  if (policy.requiresHuman && priorAttempts > 0) {
    return {
      decision: "ESCALATE",
      reason: `${bucket} policy requires human handoff after retry`,
    };
  }

  return {
    decision: "ACT",
    action: policy.action,
    cooldownMinutes: policy.cooldownMinutes,
    reason: `Within all caps - executing ${policy.action} for ${bucket}`,
  };
}

module.exports = { gate };
