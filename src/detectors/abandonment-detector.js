const GRACE_MINUTES = 15;

function detectAbandonedCheckouts(orders, payments, nowMs = Date.now()) {
  const paidOrderIds = new Set(payments.filter((p) => p.status === "captured" || p.status === "authorized").map((p) => p.order_id));

  const abandoned = [];
  for (const order of orders) {
    if (paidOrderIds.has(order.id)) continue;

    const ageMinutes = (nowMs - new Date(order.created_at).getTime()) / 60000;
    if (ageMinutes < GRACE_MINUTES) continue;

    abandoned.push({
      event_id: `evt_abandon_${order.id}`,
      type: "checkout.abandoned",
      customer_id: order.customer_id,
      amount: order.amount,
      currency: order.currency || "INR",
      order_id: order.id,
      minutes_since_order_created: Math.round(ageMinutes),
      timestamp: new Date(nowMs).toISOString(),
      attempt_number: 1,
    });
  }
  return abandoned;
}

module.exports = { detectAbandonedCheckouts, GRACE_MINUTES };
