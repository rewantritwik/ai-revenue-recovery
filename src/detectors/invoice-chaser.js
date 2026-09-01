function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / (24 * 3600 * 1000));
}

function buildOverdueEvents(invoices, nowMs = Date.now()) {
  const events = [];
  for (const inv of invoices) {
    if (inv.status !== "issued") continue;

    const dueMs = inv.expire_by ? inv.expire_by * 1000 : inv.issued_at * 1000;
    const daysOverdue = daysBetween(dueMs, nowMs);
    if (daysOverdue <= 0) continue;

    events.push({
      event_id: `evt_invoice_${inv.id}`,
      type: "invoice.overdue",
      customer_id: inv.customer_id,
      amount: inv.amount_due,
      currency: inv.currency || "INR",
      invoice_id: inv.id,
      days_overdue: daysOverdue,
      timestamp: new Date(nowMs).toISOString(),
      attempt_number: 1,
    });
  }
  return events;
}

module.exports = { buildOverdueEvents };
