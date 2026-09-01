const { ERROR_TO_BUCKET } = require("./config");

function diagnoseByErrorCode(event) {
  const bucket = ERROR_TO_BUCKET[event.error_code];
  if (bucket) {
    return {
      bucket,
      confidence: 0.95,
      reasoning: `error_code '${event.error_code}' is a known pattern mapped to ${bucket}`,
    };
  }
  return {
    bucket: "UNKNOWN",
    confidence: 0.2,
    reasoning: `error_code '${event.error_code}' not in known taxonomy - needs human classification`,
  };
}

function diagnoseAbandonment(event) {
  const minutes = event.minutes_since_order_created ?? 0;
  if (minutes < 15) {
    return { bucket: "UNKNOWN", confidence: 0.1, reasoning: "Order too recent to classify as abandoned" };
  }
  return {
    bucket: "ABANDONED_SILENT",
    confidence: 0.85,
    reasoning: `Order created ${minutes} minutes ago with no matching payment - classified as silent abandonment`,
  };
}

function diagnoseInvoice(event) {
  const daysOverdue = event.days_overdue ?? 0;
  if (daysOverdue <= 0) {
    return { bucket: "UNKNOWN", confidence: 0.1, reasoning: "Invoice not yet overdue" };
  }
  if (daysOverdue <= 7) {
    return { bucket: "INVOICE_OVERDUE_MILD", confidence: 0.9, reasoning: `${daysOverdue} days overdue - mild bucket` };
  }
  if (daysOverdue <= 30) {
    return {
      bucket: "INVOICE_OVERDUE_MODERATE",
      confidence: 0.9,
      reasoning: `${daysOverdue} days overdue - moderate bucket`,
    };
  }
  return {
    bucket: "INVOICE_OVERDUE_SEVERE",
    confidence: 0.9,
    reasoning: `${daysOverdue} days overdue - exceeds compliant auto-chase window, must escalate`,
  };
}

function diagnose(event) {
  switch (event.type) {
    case "payment.failed":
    case "subscription.charge.failed":
      return diagnoseByErrorCode(event);
    case "checkout.abandoned":
      return diagnoseAbandonment(event);
    case "invoice.overdue":
      return diagnoseInvoice(event);
    default:
      return { bucket: "UNKNOWN", confidence: 0, reasoning: `Unrecognized event type '${event.type}'` };
  }
}

module.exports = { diagnose };
