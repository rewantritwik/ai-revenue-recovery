const executedIdempotencyKeys = new Set();

let razorpayClient = null;
function getClient() {
  if (razorpayClient) return razorpayClient;
  if (!process.env.RZP_TEST_KEY || !process.env.RZP_TEST_SECRET) return null;
  const Razorpay = require("razorpay");
  razorpayClient = new Razorpay({
    key_id: process.env.RZP_TEST_KEY,
    key_secret: process.env.RZP_TEST_SECRET,
  });
  return razorpayClient;
}

function idempotencyKey(event, action) {
  return `${event.event_id}:${action}`;
}

function isRealMode(event) {
  return event.source === "real_test_mode" && getClient() !== null;
}

function extractErrorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (err && err.error && err.error.description) return `${err.error.code || "ERROR"}: ${err.error.description}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error (unserializable)";
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function realCreateRetryOrder(event) {
  const instance = getClient();
  console.log(`  >>> Calling Razorpay orders.create() for retry of ${event.event_id} ...`);
  try {
    const order = await withTimeout(
      instance.orders.create({
        amount: event.amount,
        currency: event.currency || "INR",
        receipt: `retry_${event.event_id}`,
        notes: { original_event: event.event_id, reason: "auto_retry" },
      }),
      8000,
      "orders.create()"
    );
    console.log(`  >>> orders.create() succeeded: ${order.id}`);
    return {
      status: "PENDING",
      detail: `Retry order created (${order.id}) - awaiting customer to complete payment`,
    };
  } catch (err) {
    console.log(`  >>> orders.create() FAILED: ${extractErrorMessage(err)}`);
    return { status: "FAILED", detail: `Retry order creation failed: ${extractErrorMessage(err)}` };
  }
}

async function realSendPaymentLink(event, message) {
  const instance = getClient();
  if (!event.customer_contact && !event.customer_email) {
    return { status: "FAILED", detail: "No customer contact info available - cannot send real payment link" };
  }

  async function attemptCreate(useContact, useEmail) {
    return instance.paymentLink.create({
      amount: event.amount,
      currency: event.currency || "INR",
      description: message,
      customer: {
        contact: useContact ? event.customer_contact : undefined,
        email: useEmail ? event.customer_email : undefined,
      },
      notify: { sms: useContact, email: useEmail },
      reminder_enable: true,
      reference_id: event.event_id,
      notes: { original_event: event.event_id },
    });
  }

  try {
    const link = await attemptCreate(!!event.customer_contact, !!event.customer_email);
    return { status: "PENDING", detail: `Payment link sent: ${link.short_url}` };
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    const looksLikeContactIssue = /contact|mobile|phone|digit/i.test(errMsg);
    if (looksLikeContactIssue && event.customer_contact && event.customer_email) {
      try {
        const link = await attemptCreate(false, true);
        return {
          status: "PENDING",
          detail: `Payment link sent via email only (phone rejected: ${errMsg}): ${link.short_url}`,
        };
      } catch (fallbackErr) {
        return {
          status: "FAILED",
          detail: `Payment link failed on phone (${errMsg}) AND email fallback (${extractErrorMessage(fallbackErr)})`,
        };
      }
    }
    return { status: "FAILED", detail: `Payment link creation failed: ${errMsg}` };
  }
}

async function realSendInvoiceReminder(event, channel) {
  const instance = getClient();
  if (!event.invoice_id) {
    return { status: "FAILED", detail: "No invoice_id on event - cannot send reminder" };
  }
  try {
    await instance.invoices.notifyBy(event.invoice_id, channel);
    return { status: "PENDING", detail: `Reminder sent via ${channel} for invoice ${event.invoice_id}` };
  } catch (err) {
    return { status: "FAILED", detail: `Invoice reminder failed: ${extractErrorMessage(err)}` };
  }
}

function simulate(action, forcedFailure) {
  switch (action) {
    case "AUTO_RETRY":
      if (forcedFailure) return { status: "FAILED", detail: "Retry attempt itself failed (simulated gateway timeout)" };
      return Math.random() < 0.65
        ? { status: "SUCCESS", detail: "Retry succeeded, payment captured" }
        : { status: "FAILED", detail: "Retry failed again" };

    case "SEND_PAYMENT_LINK":
    case "SEND_PAYMENT_LINK_DELAYED":
    case "SEND_PAYMENT_LINK_WITH_INSTRUCTIONS":
    case "SEND_PAYMENT_LINK_UPDATE_METHOD":
    case "SEND_PAYMENT_LINK_NEXT_DAY":
      return Math.random() < 0.4
        ? { status: "SUCCESS", detail: "Customer completed payment via link" }
        : { status: "PENDING", detail: "Link sent, no completion within window yet" };

    case "PROMPT_RETRY_IMMEDIATE":
      return Math.random() < 0.8
        ? { status: "SUCCESS", detail: "Customer corrected input and paid" }
        : { status: "FAILED", detail: "Customer did not retry" };

    case "SEND_INVOICE_REMINDER":
      return Math.random() < 0.35
        ? { status: "SUCCESS", detail: "Invoice paid after reminder" }
        : { status: "PENDING", detail: "Reminder sent, not yet paid" };

    case "SEND_FIRM_INVOICE_REMINDER":
      return Math.random() < 0.3
        ? { status: "SUCCESS", detail: "Invoice paid after firm reminder" }
        : { status: "PENDING", detail: "Firm reminder sent, not yet paid" };

    case "ESCALATE_ONLY":
      return { status: "ESCALATED", detail: "No auto-action taken by design" };

    default:
      return { status: "ERROR", detail: `Unknown action '${action}' - refusing to execute` };
  }
}

async function executeAction(event, action) {
  const key = idempotencyKey(event, action);
  if (executedIdempotencyKeys.has(key)) {
    return { status: "SKIPPED_DUPLICATE", detail: "Idempotency key already processed" };
  }
  executedIdempotencyKeys.add(key);

  const forcedFailure = event.event_id === "evt_00013";

  if (isRealMode(event)) {
    switch (action) {
      case "AUTO_RETRY":
        return realCreateRetryOrder(event);
      case "SEND_PAYMENT_LINK":
        return realSendPaymentLink(event, "Complete your payment");
      case "SEND_PAYMENT_LINK_DELAYED":
        return realSendPaymentLink(event, "A payment link for you, whenever you're ready");
      case "SEND_PAYMENT_LINK_WITH_INSTRUCTIONS":
        return realSendPaymentLink(event, "Please enable your card for online payments, then use this link");
      case "SEND_PAYMENT_LINK_UPDATE_METHOD":
        return realSendPaymentLink(event, "Your card has expired - please pay with an updated method");
      case "SEND_PAYMENT_LINK_NEXT_DAY":
        return realSendPaymentLink(event, "Your transaction limit was reached - here's a link for tomorrow");
      case "SEND_INVOICE_REMINDER":
        return realSendInvoiceReminder(event, "email");
      case "SEND_FIRM_INVOICE_REMINDER":
        return realSendInvoiceReminder(event, "sms");
      case "PROMPT_RETRY_IMMEDIATE":
        return { status: "PENDING", detail: "Awaiting customer to retry entry on their own session" };
      case "ESCALATE_ONLY":
        return { status: "ESCALATED", detail: "No auto-action taken by design" };
      default:
        return { status: "ERROR", detail: `Unknown action '${action}' - refusing to execute` };
    }
  }

  return simulate(action, forcedFailure);
}

module.exports = { executeAction };
