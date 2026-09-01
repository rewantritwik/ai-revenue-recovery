# AI Revenue Recovery Agent

Detects revenue at risk across all four loss types named in the brief, diagnoses root
cause, and executes a **bounded, audited, compliant** recovery action — never a
free-form agent decision.

> "Don't just identify the problem. Show measured money recovered across a batch,
> with compliant escalation, stopping rules, and an audit trail." — the bar this
> system is built against, clause by clause.

## The four loops

| Loss type | How it's detected | File |
|---|---|---|
| Payment degrades | Razorpay `payment.failed` webhook | `src/server/webhook-server.js` |
| Subscription fails | Razorpay `subscription.charge.failed` webhook | `src/server/webhook-server.js` |
| Checkout abandoned | No webhook exists for this — polls Orders vs Payments, flags orders unpaid after 15 min | `src/detectors/abandonment-detector.js` |
| Invoice overdue | Polls Invoices API, buckets by days overdue on an escalation ladder | `src/detectors/invoice-chaser.js` |

All four feed the same pipeline: **diagnose → gate → act → audit**.

## Quick start (synthetic demo, no Razorpay account needed)

```bash
npm install
npm run demo
```

This generates a 100+ event batch across all four loss types and prints a full
report: total at risk, total recovered, recovery rate, and a bucket-by-bucket
breakdown. Full detail lands in `logs/audit-log.jsonl` (one line per decision)
and `logs/report.json`.

## Going live against real Razorpay test-mode

1. Create a Razorpay account, switch to **Test Mode**, grab your test API keys.
2. Set env vars: `RZP_TEST_KEY`, `RZP_TEST_SECRET`, `RZP_WEBHOOK_SECRET`.
3. Download `cloudflared` for Windows from
   https://github.com/cloudflare/cloudflared/releases/latest
   (grab `cloudflared-windows-amd64.exe`, rename to `cloudflared.exe`, place it
   in this project folder). Run `npm run webhook-server`, then in a second
   terminal `npm run tunnel` — it prints a `https://xxx.trycloudflare.com` URL.
4. In the Razorpay dashboard, add a Test Mode webhook pointed at
   `https://<your-tunnel>/webhook`, subscribed to at minimum:
   `payment.failed`, `payment.captured`, `order.paid`, `payment_link.paid`,
   `payment_link.expired`, `payment_link.cancelled`.
5. Trigger real test failures using the cards in
   `data/razorpay-test-reference.md`.
6. Run `npm run dashboard` to regenerate the dashboard with live data.

## Why this satisfies the bar

- **Bounded**: every bucket in `src/core/config.js` maps to exactly one allowed action —
  the agent cannot invent an action outside this table.
- **Gated**: `src/core/policy-gate.js` enforces retry caps, amount caps, per-customer
  caps, and a hard compliance line (invoices over 30 days always escalate to a
  human; fraud-flagged payments never get auto-acted on at all).
- **Auditable**: every decision — act or escalate — writes one immutable line
  to `logs/audit-log.jsonl` with the diagnosis, confidence, reasoning, action,
  and outcome.
- **Measured**: `src/tools/run-batch.js` computes real recovery rate, broken down by
  bucket, plus an honest exceptions list of everything the agent could not
  resolve on its own.
- **Graceful failure handling**: `src/core/action-executor.js` deliberately injects one
  forced failure (`evt_00013`) so the demo shows the system logging and
  stopping cleanly rather than looping or crashing.

## Project structure

```
src/
  core/
    config.js                      - bucket -> action -> caps (single source of policy truth)
    diagnose.js                    - routes each event type to the right diagnosis logic
    policy-gate.js                 - enforces all caps, cooldowns, and escalation rules
    action-executor.js             - executes the action (real Razorpay calls or simulated)
  detectors/
    abandonment-detector.js        - orders-vs-payments comparison for silent abandonment
    invoice-chaser.js              - overdue invoice detection + compliance-aware bucketing
  server/
    webhook-server.js              - real Express receiver for live Razorpay test-mode traffic
    start-tunnel.js                - Cloudflare tunnel for exposing local server
  tools/
    generate-synthetic-data.js     - builds a realistic 100+ event batch across all 4 loops
    run-batch.js                   - orchestrates the batch run + produces the metrics report
    generate-dashboard.js          - generates the self-contained dashboard.html
  test/
    create-test-order-example.js   - creates a real test-mode order for manual testing
    test-checkout.html             - browser page to trigger a test payment
data/
  synthetic-batch.json             - generated synthetic event data
  razorpay-test-reference.md       - real test card numbers and error taxonomy
logs/
  audit-log.jsonl                  - immutable audit log of every decision
  report.json                      - batch metrics report
```