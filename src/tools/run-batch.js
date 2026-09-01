const fs = require("fs");
const path = require("path");
const { diagnose } = require("../core/diagnose");
const { gate } = require("../core/policy-gate");
const { executeAction } = require("../core/action-executor");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "synthetic-batch.json");
const AUDIT_LOG_FILE = path.join(__dirname, "..", "..", "logs", "audit-log.jsonl");
const REPORT_FILE = path.join(__dirname, "..", "..", "logs", "report.json");

function appendAuditEntry(entry) {
  fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
}

async function processEvent(event, attemptHistory) {
  const diagnosis = diagnose(event);
  const decision = gate(event, diagnosis, attemptHistory);

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
    diagnosis_reasoning: diagnosis.reasoning,
    gate_decision: decision.decision,
    gate_reason: decision.reason,
  };

  if (decision.decision === "ESCALATE") {
    const entry = { ...baseEntry, actor: "human_queue", action_taken: "NONE", outcome: "ESCALATED" };
    appendAuditEntry(entry);
    return entry;
  }

  const result = await executeAction(event, decision.action);
  const entry = {
    ...baseEntry,
    actor: "agent",
    action_taken: decision.action,
    outcome: result.status,
    outcome_detail: result.detail,
  };
  appendAuditEntry(entry);
  return entry;
}

async function runBatch() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error("No synthetic batch found. Run `node src/tools/generate-synthetic-data.js` first.");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });

  let preservedRealLines = [];
  if (fs.existsSync(AUDIT_LOG_FILE)) {
    const existingLines = fs.readFileSync(AUDIT_LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
    preservedRealLines = existingLines.filter((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.source === "real_test_mode" || entry.actor === "razorpay_webhook";
      } catch {
        return false;
      }
    });
  }
  fs.writeFileSync(AUDIT_LOG_FILE, preservedRealLines.length ? preservedRealLines.join("\n") + "\n" : "");
  if (preservedRealLines.length) {
    console.log(`Preserved ${preservedRealLines.length} real live-webhook audit entries across this reset.`);
  }

  const events = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  const attemptHistory = {};
  const results = [];

  for (const event of events) {
    const entry = await processEvent(event, attemptHistory);
    attemptHistory[event.event_id] = (attemptHistory[event.event_id] || 0) + 1;
    results.push(entry);
  }

  const report = buildReport(results);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  printReport(report);
  return report;
}

function buildReport(results) {
  const totalAtRisk = results.reduce((s, r) => s + r.amount, 0);
  const recovered = results.filter((r) => r.outcome === "SUCCESS");
  const totalRecovered = recovered.reduce((s, r) => s + r.amount, 0);
  const escalated = results.filter((r) => r.gate_decision === "ESCALATE");
  const pending = results.filter((r) => r.outcome === "PENDING");
  const failed = results.filter((r) => r.outcome === "FAILED");

  const NEVER_AUTO_RECOVERABLE = new Set(["FRAUD_FLAG", "BLOCKED", "INVOICE_OVERDUE_SEVERE"]);
  const addressable = results.filter((r) => !NEVER_AUTO_RECOVERABLE.has(r.diagnosis_bucket));
  const addressableAtRisk = addressable.reduce((s, r) => s + r.amount, 0);
  const addressableRecovered = addressable
    .filter((r) => r.outcome === "SUCCESS")
    .reduce((s, r) => s + r.amount, 0);
  const excludedByDesignAtRisk = totalAtRisk - addressableAtRisk;

  const byBucket = {};
  for (const r of results) {
    byBucket[r.diagnosis_bucket] = byBucket[r.diagnosis_bucket] || { count: 0, recovered: 0, atRisk: 0 };
    byBucket[r.diagnosis_bucket].count += 1;
    byBucket[r.diagnosis_bucket].atRisk += r.amount;
    if (r.outcome === "SUCCESS") byBucket[r.diagnosis_bucket].recovered += r.amount;
  }

  return {
    batch_size: results.length,
    total_at_risk_inr: (totalAtRisk / 100).toFixed(2),
    total_recovered_inr: (totalRecovered / 100).toFixed(2),
    recovery_rate_pct: ((totalRecovered / totalAtRisk) * 100).toFixed(1),
    addressable_recovery: {
      note: "Excludes FRAUD_FLAG, BLOCKED, and INVOICE_OVERDUE_SEVERE - these are never eligible for automated recovery by policy design, not agent failures.",
      addressable_at_risk_inr: (addressableAtRisk / 100).toFixed(2),
      addressable_recovered_inr: (addressableRecovered / 100).toFixed(2),
      addressable_recovery_rate_pct: ((addressableRecovered / addressableAtRisk) * 100).toFixed(1),
      excluded_by_design_inr: (excludedByDesignAtRisk / 100).toFixed(2),
    },
    counts: {
      recovered: recovered.length,
      escalated_to_human: escalated.length,
      still_pending: pending.length,
      failed_no_recovery: failed.length,
    },
    breakdown_by_bucket: Object.fromEntries(
      Object.entries(byBucket).map(([bucket, v]) => [
        bucket,
        {
          count: v.count,
          at_risk_inr: (v.atRisk / 100).toFixed(2),
          recovered_inr: (v.recovered / 100).toFixed(2),
          recovery_rate_pct: v.atRisk ? ((v.recovered / v.atRisk) * 100).toFixed(1) : "0.0",
        },
      ])
    ),
    exceptions: escalated.map((r) => ({
      event_id: r.event_id,
      reason: r.gate_reason,
      amount_inr: (r.amount / 100).toFixed(2),
    })),
  };
}

function printReport(report) {
  console.log("\n=== AI Revenue Recovery — Batch Report ===");
  console.log(`Batch size: ${report.batch_size}`);
  console.log(`Total at risk: ₹${report.total_at_risk_inr}`);
  console.log(`Total recovered: ₹${report.total_recovered_inr}`);
  console.log(`Blended recovery rate (all events): ${report.recovery_rate_pct}%`);
  console.log(`Addressable recovery rate (excludes fraud/blocked/severe-overdue): ${report.addressable_recovery.addressable_recovery_rate_pct}%`);
  console.log(`  (₹${report.addressable_recovery.excluded_by_design_inr} correctly excluded from auto-recovery by policy)`);
  console.log(`Recovered: ${report.counts.recovered} | Escalated: ${report.counts.escalated_to_human} | Pending: ${report.counts.still_pending} | Failed: ${report.counts.failed_no_recovery}`);
  console.log("\nBy bucket:");
  for (const [bucket, v] of Object.entries(report.breakdown_by_bucket)) {
    console.log(`  ${bucket}: ${v.count} events, ₹${v.recovered_inr}/₹${v.at_risk_inr} recovered (${v.recovery_rate_pct}%)`);
  }
  console.log(`\nExceptions (escalated, unresolved by agent): ${report.exceptions.length}`);
  console.log(`Full audit log: logs/audit-log.jsonl`);
  console.log(`Full report: logs/report.json\n`);
}

if (require.main === module) {
  runBatch();
}

module.exports = { runBatch };
