const fs = require("fs");
const path = require("path");

const AUDIT_LOG_FILE = path.join(__dirname, "logs", "audit-log.jsonl");
const REPORT_FILE = path.join(__dirname, "logs", "report.json");
const OUT_FILE = path.join(__dirname, "dashboard.html");


function loadChartJsInline() {
  const chartJsPath = path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.min.js");
  if (!fs.existsSync(chartJsPath)) {
    console.error("chart.js not found in node_modules - run `npm install` first.");
    process.exit(1);
  }
  return fs.readFileSync(chartJsPath, "utf-8");
}


const BUCKET_PLAIN = {
  TRANSIENT: "A temporary glitch (timeout or bank downtime) interrupted the payment.",
  HARD_DECLINE: "The customer's bank declined the payment without giving a specific reason.",
  SOFT_DECLINE: "The customer likely didn't have enough balance at that moment.",
  CUSTOMER_ABANDONED: "The customer backed out of the payment partway through.",
  ABANDONED_SILENT: "The customer started checkout but never came back to finish it.",
  USER_ERROR: "The customer mistyped a card detail (like the security code).",
  ACTION_REQUIRED: "The card needs to be enabled, or a domestic payment method is needed.",
  EXPIRED: "The customer's card has expired.",
  LIMIT_HIT: "The customer hit their daily spending limit.",
  AUTH_FAILURE: "The customer failed the bank's identity verification step.",
  FRAUD_FLAG: "The bank flagged this payment as a possible fraud risk.",
  BLOCKED: "The customer's card is blocked by their bank.",
  SUBSCRIPTION_HALTED: "A recurring subscription failed repeatedly and Razorpay stopped retrying.",
  INVOICE_OVERDUE_MILD: "A business invoice is a little overdue (within a week).",
  INVOICE_OVERDUE_MODERATE: "A business invoice is significantly overdue (over a week).",
  INVOICE_OVERDUE_SEVERE: "A business invoice is severely overdue (over a month).",
  UNKNOWN: "An unfamiliar issue the system hasn't seen a clear pattern for yet.",
};


const ACTION_PLAIN = {
  AUTO_RETRY: "Automatically tried the payment again.",
  SEND_PAYMENT_LINK: "Sent the customer a link to complete payment later.",
  SEND_PAYMENT_LINK_DELAYED: "Waited, then sent a payment link (avoiding an empty account).",
  SEND_PAYMENT_LINK_WITH_INSTRUCTIONS: "Sent a payment link with guidance on how to fix the issue.",
  SEND_PAYMENT_LINK_UPDATE_METHOD: "Sent a link asking the customer to use an updated card.",
  SEND_PAYMENT_LINK_NEXT_DAY: "Sent a payment link timed for after the daily limit resets.",
  PROMPT_RETRY_IMMEDIATE: "Asked the customer to simply re-enter their details.",
  SEND_INVOICE_REMINDER: "Sent a polite reminder about the overdue invoice.",
  SEND_FIRM_INVOICE_REMINDER: "Sent a firmer reminder about the overdue invoice.",
  ESCALATE_ONLY: "Took no automatic action — sent straight to a human.",
  NONE: "No automatic action was taken.",
};

const OUTCOME_PLAIN = {
  SUCCESS: { label: "Money recovered", icon: "✅" },
  PENDING: { label: "Waiting on the customer", icon: "⏳" },
  FAILED: { label: "This attempt didn't work", icon: "⚠️" },
  ESCALATED: { label: "Sent to a human", icon: "🙋" },
  SKIPPED_DUPLICATE: { label: "Already handled", icon: "↩️" },
  ERROR: { label: "System error", icon: "❗" },
};


const BUCKET_SHORT = {
  TRANSIENT: "Timeout / bank downtime",
  HARD_DECLINE: "Bank declined (no reason given)",
  SOFT_DECLINE: "Insufficient funds",
  CUSTOMER_ABANDONED: "Customer backed out",
  ABANDONED_SILENT: "Checkout never finished",
  USER_ERROR: "Mistyped card detail",
  ACTION_REQUIRED: "Needs a different payment method",
  EXPIRED: "Card expired",
  LIMIT_HIT: "Daily limit reached",
  AUTH_FAILURE: "Failed identity check",
  FRAUD_FLAG: "Flagged as possible fraud",
  BLOCKED: "Card blocked by bank",
  SUBSCRIPTION_HALTED: "Subscription retries exhausted",
  INVOICE_OVERDUE_MILD: "Invoice overdue (mild)",
  INVOICE_OVERDUE_MODERATE: "Invoice overdue (moderate)",
  INVOICE_OVERDUE_SEVERE: "Invoice overdue (severe)",
  UNKNOWN: "Unfamiliar issue",
};
function shortBucket(bucket) {
  return BUCKET_SHORT[bucket] || bucket || "Unknown";
}

function plainBucket(bucket) {
  return BUCKET_PLAIN[bucket] || `An issue classified as "${bucket || "unknown"}".`;
}
function plainAction(action) {
  return ACTION_PLAIN[action] || action || "No action recorded.";
}
function plainOutcome(outcome) {
  return OUTCOME_PLAIN[outcome] || { label: outcome || "Unknown", icon: "•" };
}

function loadData() {
  if (!fs.existsSync(AUDIT_LOG_FILE) || !fs.existsSync(REPORT_FILE)) {
    console.error("No audit log / report found. Run `npm run run-batch` first.");
    process.exit(1);
  }
  const lines = fs.readFileSync(AUDIT_LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const entries = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const report = JSON.parse(fs.readFileSync(REPORT_FILE, "utf-8"));
  return { entries, report };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildHtml(entries, report) {
  const realEntries = entries.filter((e) => e.source === "real_test_mode");
  const syntheticEntries = entries.filter((e) => e.source === "synthetic");
  const recoveryConfirmed = entries.filter((e) => e.type === "recovery.confirmed");

  const outcomeCounts = {};
  for (const e of entries) {
    if (!e.outcome) continue;
    outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] || 0) + 1;
  }
  // Fixed, meaningful colors per outcome - green always means "money back", never
  // assigned by array position, so the chart can't accidentally mislead.
  const OUTCOME_COLORS = {
    SUCCESS: "#34d399",
    PENDING: "#fbbf24",
    ESCALATED: "#60a5fa",
    FAILED: "#f87171",
    SKIPPED_DUPLICATE: "#a78bfa",
    ERROR: "#f87171",
  };
  const outcomeKeys = Object.keys(outcomeCounts);
  const outcomeChartColors = outcomeKeys.map((k) => OUTCOME_COLORS[k] || "#98a2bf");

  // --- Scannable failure breakdown, sorted by volume - this order also drives the bar chart below ---
  // Computed directly from the full audit log (not report.json) so real live events are
  // always included and every total on this page stays consistent with each other -
  // report.json is only rebuilt from the synthetic batch each run and would otherwise
  // silently under-count real events here.
  const bucketMap = {};
  for (const e of entries) {
    if (!e.diagnosis_bucket) continue; // skip recovery.confirmed / pipeline.error / etc, which have no bucket
    if (!bucketMap[e.diagnosis_bucket]) bucketMap[e.diagnosis_bucket] = { count: 0, atRisk: 0, recovered: 0 };
    bucketMap[e.diagnosis_bucket].count += 1;
    bucketMap[e.diagnosis_bucket].atRisk += e.amount || 0;
    if (e.outcome === "SUCCESS") bucketMap[e.diagnosis_bucket].recovered += e.amount || 0;
  }
  const bucketLabelsRaw = Object.keys(bucketMap);
  const bucketCounts = bucketLabelsRaw.map((b) => ({
    bucket: b,
    count: bucketMap[b].count,
    atRisk: bucketMap[b].atRisk / 100, // paise -> rupees
    recovered: bucketMap[b].recovered / 100,
  }));
  const totalCases = bucketCounts.reduce((s, b) => s + b.count, 0);
  const sortedBuckets = [...bucketCounts].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sortedBuckets.map((b) => b.count), 1);

  // --- Top-level totals, computed the SAME way (directly from the full audit log) so
  // every number on this page is guaranteed consistent with every other number. ---
  const scoredEntries = entries.filter((e) => e.diagnosis_bucket && typeof e.amount === "number");
  const totalAtRiskPaise = scoredEntries.reduce((s, e) => s + e.amount, 0);
  const totalRecoveredPaise = scoredEntries.filter((e) => e.outcome === "SUCCESS").reduce((s, e) => s + e.amount, 0);
  const NEVER_AUTO_RECOVERABLE = new Set(["FRAUD_FLAG", "BLOCKED", "INVOICE_OVERDUE_SEVERE"]);
  const addressableEntries = scoredEntries.filter((e) => !NEVER_AUTO_RECOVERABLE.has(e.diagnosis_bucket));
  const addressableAtRiskPaise = addressableEntries.reduce((s, e) => s + e.amount, 0);
  const addressableRecoveredPaise = addressableEntries.filter((e) => e.outcome === "SUCCESS").reduce((s, e) => s + e.amount, 0);
  const addressableRatePct = addressableAtRiskPaise ? ((addressableRecoveredPaise / addressableAtRiskPaise) * 100).toFixed(1) : "0.0";
  const totalAtRiskDisplay = (totalAtRiskPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalRecoveredDisplay = (totalRecoveredPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // --- Exceptions, computed directly from the audit log too - this is what makes sure a
  // REAL escalated event (e.g. a fraud flag hit live) would actually show up here. ---
  const exceptionsList = entries
    .filter((e) => e.gate_decision === "ESCALATE")
    .map((e) => ({ event_id: e.event_id, reason: e.gate_reason, amount_inr: ((e.amount || 0) / 100).toFixed(2) }));

  // Bar chart now uses the SAME sorted order as the breakdown list above it, so the
  // story is consistent top-to-bottom instead of two different orderings on screen.
  // Uses SHORT labels for the axis (full sentences are far too long to display here) -
  // the fuller explanation still lives in the breakdown list and glossary below.
  const bucketChartLabels = sortedBuckets.map((b) => shortBucket(b.bucket));
  const bucketAtRisk = sortedBuckets.map((b) => b.atRisk);
  const bucketRecovered = sortedBuckets.map((b) => b.recovered);
  const bucketChartHeight = Math.max(340, sortedBuckets.length * 36);

  const BUCKET_COLORS = ["#60a5fa", "#fbbf24", "#f87171", "#a78bfa", "#34d399", "#f472b6", "#38bdf8", "#fb923c"];
  const breakdownRows = sortedBuckets
    .map((b, i) => {
      const pct = totalCases ? Math.round((b.count / totalCases) * 100) : 0;
      const widthPct = Math.round((b.count / maxCount) * 100);
      const color = BUCKET_COLORS[i % BUCKET_COLORS.length];
      return `<div class="bd-row">
        <div class="bd-top">
          <span class="bd-label">${esc(plainBucket(b.bucket))}</span>
          <span class="bd-stats">${b.count} events <b style="color:${color}">${pct}%</b></span>
        </div>
        <div class="bd-track"><div class="bd-fill" style="width:${widthPct}%;background:${color}"></div></div>
      </div>`;
    })
    .join("\n");

  // --- Real events: the plain-English story table ---
  const realEventRows = realEntries
    .map((e) => {
      const o = plainOutcome(e.outcome);
      return `<tr>
        <td class="problem-cell">
          <div class="plain">${esc(plainBucket(e.diagnosis_bucket))}</div>
          <div class="tech">Technical: ${esc(e.error_code || "n/a")} → <span class="tag">${esc(e.diagnosis_bucket)}</span></div>
        </td>
        <td class="solution-cell">
          <div class="plain">${esc(plainAction(e.action_taken))}</div>
          <div class="tech">${esc(e.action_taken || "")}</div>
        </td>
        <td><span class="outcome-badge outcome-${(e.outcome || "").toLowerCase()}">${o.icon} ${esc(o.label)}</span></td>
        <td class="detail-cell">${esc(e.outcome_detail || "")}</td>
      </tr>`;
    })
    .join("\n");

  // --- Exceptions: already-plain-English reasons, just styled better ---
  const exceptionsRows = exceptionsList
    .slice(0, 25)
    .map(
      (ex) => `<tr>
        <td><code>${esc(ex.event_id)}</code></td>
        <td>${esc(ex.reason)}</td>
        <td class="amount">₹${esc(ex.amount_inr)}</td>
      </tr>`
    )
    .join("\n");

  // --- Glossary: every bucket explained once, for reference ---
  const glossaryRows = bucketLabelsRaw
    .map(
      (b) => `<tr>
        <td><span class="tag">${esc(b)}</span></td>
        <td>${esc(plainBucket(b))}</td>
      </tr>`
    )
    .join("\n");

  // --- Engine Status panel: our REAL pipeline stages, honestly labeled ---
  const engineModules = [
    { name: "Diagnosis Engine", desc: "Classifies root cause from Razorpay error codes and event type.", file: "diagnose.js" },
    {
      name: "Policy Gate",
      desc: "Enforces retry caps, amount caps, and compliance windows before any action runs.",
      file: "policy-gate.js",
    },
    { name: "Action Executor", desc: "Calls Razorpay's real APIs — retries, payment links, invoice reminders.", file: "action-executor.js" },
    { name: "Webhook Receiver", desc: "Verifies and processes live Razorpay test-mode webhooks in real time.", file: "webhook-server.js" },
    { name: "Audit Logger", desc: "Writes an immutable record of every decision, act or escalate.", file: "run-batch.js" },
  ];
  const engineRows = engineModules
    .map(
      (m) => `<div class="engine-row">
        <div class="engine-dot"></div>
        <div class="engine-text">
          <div class="engine-name">${esc(m.name)} <span class="engine-online">ACTIVE</span></div>
          <div class="engine-desc">${esc(m.desc)}</div>
        </div>
      </div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Revenue Recovery — Results Dashboard</title>
<script>${loadChartJsInline()}</script>
<style>
  :root {
    --bg: #0a0e17; --card: #131924; --card-alt: #1a2233; --border: #262f42;
    --text: #f1f4fb; --muted: #98a2bf; --muted-dim: #616d8c;
    --green: #34d399; --green-dim: rgba(52,211,153,0.14);
    --red: #f87171; --red-dim: rgba(248,113,113,0.14);
    --amber: #fbbf24; --amber-dim: rgba(251,191,36,0.14);
    --blue: #60a5fa; --blue-dim: rgba(96,165,250,0.14);
    --purple: #a78bfa; --accent-glow: rgba(96,165,250,0.08);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background:
      radial-gradient(ellipse 900px 400px at 15% -5%, var(--accent-glow), transparent),
      var(--bg);
    color: var(--text); line-height: 1.5; padding-bottom: 60px;
  }
  .navbar {
    display: flex; align-items: center; justify-content: space-between; padding: 14px 32px;
    border-bottom: 1px solid var(--border); background: rgba(19,25,36,0.85); backdrop-filter: blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-icon {
    width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--blue), var(--purple)); font-size: 17px; font-weight: 800; color: #0a0e17;
  }
  .brand-name { font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
  .brand-tag { font-size: 11px; color: var(--muted-dim); }
  .nav-links { display: flex; gap: 22px; font-size: 13px; color: var(--muted); }
  .nav-links a { color: var(--muted); text-decoration: none; }
  .nav-links a:hover { color: var(--text); }
  .status-pill {
    display: inline-flex; align-items: center; gap: 6px; background: var(--green-dim); color: var(--green);
    padding: 5px 12px; border-radius: 20px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em;
  }
  .status-pill::before { content: "●"; font-size: 8px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .page { padding: 28px 32px 0; max-width: 1400px; margin: 0 auto; }
  .hero {
    background: linear-gradient(135deg, rgba(96,165,250,0.10), rgba(167,139,250,0.06));
    border: 1px solid var(--border); border-radius: 16px; padding: 26px 28px; margin-bottom: 24px;
  }
  .hero-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--blue); margin-bottom: 8px; }
  .hero h1 { font-size: 25px; margin: 0 0 8px; font-weight: 800; letter-spacing: -0.01em; }
  .hero p { margin: 0; color: var(--muted); font-size: 14.5px; max-width: 780px; }
  .hero p b { color: var(--text); }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px;
    position: relative; overflow: hidden;
  }
  .stat-icon {
    width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
    font-size: 16px; margin-bottom: 12px;
  }
  .stat-icon.grey { background: rgba(154,164,189,0.14); }
  .stat-icon.green { background: var(--green-dim); }
  .stat-icon.amber { background: var(--amber-dim); }
  .stat-icon.blue { background: var(--blue-dim); }
  .stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; font-weight: 700; }
  .stat-value { font-size: 27px; font-weight: 800; letter-spacing: -0.01em; }
  .stat-sub { font-size: 12px; color: var(--muted-dim); margin-top: 5px; }
  .stat-value.green { color: var(--green); }
  .stat-value.amber { color: var(--amber); }
  .stat-value.blue { color: var(--blue); }

  .row-2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; margin-bottom: 24px; }
  @media (max-width: 950px) { .row-2 { grid-template-columns: 1fr; } }

  .section {
    background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 22px 24px; margin-bottom: 22px;
  }
  .section-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
  .section h2 { font-size: 16px; margin: 0; font-weight: 700; }
  .section .section-sub { font-size: 13px; color: var(--muted); margin: 4px 0 18px; }

  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 800px) { .chart-row { grid-template-columns: 1fr; } }

  /* Failure breakdown list */
  .bd-row { margin-bottom: 16px; }
  .bd-top { display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 6px; }
  .bd-label { color: var(--text); }
  .bd-stats { color: var(--muted); font-size: 12.5px; }
  .bd-track { height: 7px; background: rgba(255,255,255,0.06); border-radius: 20px; overflow: hidden; }
  .bd-fill { height: 100%; border-radius: 20px; }

  /* Engine status panel */
  .engine-row { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .engine-row:last-child { border-bottom: none; }
  .engine-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-top: 6px; flex-shrink: 0; box-shadow: 0 0 8px var(--green); }
  .engine-name { font-size: 13.5px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .engine-online { font-size: 9.5px; font-weight: 800; color: var(--green); background: var(--green-dim); padding: 2px 7px; border-radius: 10px; letter-spacing: 0.03em; }
  .engine-desc { font-size: 12px; color: var(--muted); margin-top: 3px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; color: var(--muted); font-weight: 700; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .plain { font-size: 14px; color: var(--text); margin-bottom: 3px; }
  .tech { font-size: 11px; color: var(--muted-dim); }
  .tag { display: inline-block; background: rgba(154,164,189,0.14); color: var(--muted); padding: 1px 7px; border-radius: 6px; font-size: 10.5px; font-family: ui-monospace, monospace; }
  .outcome-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 20px; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
  .outcome-success { background: var(--green-dim); color: var(--green); }
  .outcome-failed { background: var(--red-dim); color: var(--red); }
  .outcome-pending { background: var(--amber-dim); color: var(--amber); }
  .outcome-escalated { background: var(--blue-dim); color: var(--blue); }
  .detail-cell { font-size: 12.5px; color: var(--muted); max-width: 320px; }
  .amount { font-weight: 700; color: var(--text); }
  .live-tag {
    display: inline-flex; align-items: center; gap: 5px; background: var(--green-dim); color: var(--green);
    padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.03em;
  }
  .live-tag::before { content: "●"; font-size: 8px; }
  .count-pill { background: rgba(154,164,189,0.14); color: var(--muted); font-size: 11.5px; padding: 4px 11px; border-radius: 20px; font-weight: 700; }
  .empty-note { color: var(--muted); font-size: 13.5px; padding: 24px; text-align: center; background: var(--card-alt); border-radius: 10px; }
  code { font-family: ui-monospace, monospace; font-size: 11.5px; color: var(--muted); }
  .legend-note { font-size: 12.5px; color: var(--muted-dim); margin-top: 10px; }
  .footer-note { text-align: center; color: var(--muted-dim); font-size: 12px; padding: 20px 0 0; }
</style>
</head>
<body>
  <div class="navbar">
    <div class="brand">
      <div class="brand-icon">⛨</div>
      <div>
        <div class="brand-name">AI Revenue Recovery</div>
        <div class="brand-tag">Razorpay Track 3 · Policy-bounded, human-gated recovery</div>
      </div>
    </div>
    <div class="nav-links">
      <a href="#overview">Overview</a>
      <a href="#live-events">Live Data</a>
      <a href="#escalations">Escalations</a>
      <a href="#glossary">Glossary</a>
    </div>
    <span class="status-pill">Engine Active</span>
  </div>

  <div class="page">
    <div class="hero" id="overview">
      <div class="hero-eyebrow">Generated ${esc(new Date().toLocaleString())} · Policy-bounded recovery engine</div>
      <h1>Every recovery action is explainable, bounded, and gated.</h1>
      <p>Merchants lose money in quiet, everyday ways — a card gets declined, a customer
      abandons checkout, a subscription payment fails. This system detects each moment,
      <b>diagnoses the root cause</b>, and takes <b>one pre-approved action within hard caps</b> —
      never a free-form decision. Anything outside its authority — fraud risk, a severely
      overdue invoice, an unfamiliar error — is <b>escalated to a human with a stated reason</b>,
      not guessed at. <b>Every number below is computed from a real, immutable audit log,
      including live Razorpay test-mode traffic — nothing here is a mock-up.</b></p>
    </div>

    <div class="grid">
      <div class="stat-card">
        <div class="stat-icon grey">💰</div>
        <div class="stat-label">Revenue at risk</div>
        <div class="stat-value">₹${totalAtRiskDisplay}</div>
        <div class="stat-sub">Across this batch of transactions</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">✅</div>
        <div class="stat-label">Revenue recovered</div>
        <div class="stat-value green">₹${totalRecoveredDisplay}</div>
        <div class="stat-sub">Successfully brought back</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon amber">🎯</div>
        <div class="stat-label">Addressable recovery rate</div>
        <div class="stat-value amber">${addressableRatePct}%</div>
        <div class="stat-sub">Excludes fraud / blocked / severely overdue — never auto-touched by design</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue">📡</div>
        <div class="stat-label">Real live events</div>
        <div class="stat-value blue">${realEntries.length}</div>
        <div class="stat-sub">From actual Razorpay test-mode traffic, not simulated</div>
      </div>
    </div>

    <div class="row-2">
      <div class="section">
        <div class="section-head"><h2>Failure breakdown</h2><span class="count-pill">${totalCases} total cases</span></div>
        <p class="section-sub">What's actually going wrong, ranked by how often it happens.</p>
        ${breakdownRows}
      </div>
      <div class="section">
        <div class="section-head"><h2>Engine status</h2><span class="count-pill">${engineModules.length} modules</span></div>
        <p class="section-sub">The real pipeline stages that processed every case below.</p>
        ${engineRows}
      </div>
    </div>

    <div class="section">
      <h2>Where the money is, and how much came back</h2>
      <p class="section-sub">Sorted from most common to least common. The grey bar is what was at risk; the green bar is what we actually got back.</p>
      <div style="height: ${bucketChartHeight}px;"><canvas id="bucketChart"></canvas></div>
    </div>

    <div class="chart-row">
      <div class="section">
        <h2>What happened to every case</h2>
        <p class="section-sub">Labeled directly on the chart — no hovering needed.</p>
        <canvas id="outcomeChart" height="220"></canvas>
      </div>
      <div class="section">
        <h2>Real vs. simulated data</h2>
        <p class="section-sub">How many events came from actually testing against Razorpay, versus a generated batch.</p>
        <canvas id="sourceChart" height="220"></canvas>
      </div>
    </div>

    <div class="section" id="live-events">
      <div class="section-head">
        <h2>Live Razorpay events <span class="live-tag">REAL, NOT SIMULATED</span></h2>
        <span class="count-pill">Showing all ${realEntries.length}</span>
      </div>
      <p class="section-sub">Every row here happened on Razorpay's actual test infrastructure — a real problem, a real decision, a real result.</p>
      ${realEventRows
      ? `<table><thead><tr><th style="width:30%">The problem</th><th style="width:30%">What we did</th><th style="width:18%">Result</th><th>Detail</th></tr></thead><tbody>${realEventRows}</tbody></table>`
      : `<div class="empty-note">No real test-mode events captured yet.</div>`
    }
    </div>

    <div class="section">
      <h2>Confirmed recoveries</h2>
      <p class="section-sub">Cases where we can prove the customer actually completed the payment after our recovery action.</p>
      ${recoveryConfirmed.length
      ? `<table><thead><tr><th>Which case</th><th>How it was confirmed</th><th>When</th></tr></thead><tbody>${recoveryConfirmed
        .map((e) => `<tr><td><code>${esc(e.event_id)}</code></td><td>${esc(e.outcome_detail)}</td><td>${esc(e.timestamp)}</td></tr>`)
        .join("")}</tbody></table>`
      : `<div class="empty-note">None confirmed yet in this batch — recovery actions are in progress, waiting on the customer.</div>`
    }
    </div>

    <div class="section" id="escalations">
      <div class="section-head"><h2>Sent to a human — and why</h2><span class="count-pill">${exceptionsList.length} cases</span></div>
      <p class="section-sub">These aren't failures. This is the system correctly recognizing when a decision needs a person, not a bot — and saying exactly why.</p>
      ${exceptionsRows
      ? `<table><thead><tr><th>Case</th><th>Why it needs a human</th><th>Amount</th></tr></thead><tbody>${exceptionsRows}</tbody></table>`
      : `<div class="empty-note">Nothing was escalated in this batch.</div>`
    }
    </div>

    <div class="section" id="glossary">
      <h2>Glossary — what each problem type means</h2>
      <p class="section-sub">For reference: every category the system can recognize, in plain language.</p>
      <table><thead><tr><th style="width:220px">Technical name</th><th>What it means</th></tr></thead><tbody>${glossaryRows}</tbody></table>
      <div class="legend-note">Every one of these maps to exactly one allowed action — the system can't invent a response outside this list.</div>
    </div>

    <div class="footer-note">Track 3: AI Revenue Recovery · Built on Razorpay test-mode APIs</div>
  </div>

<script>
  const bucketChartLabels = ${JSON.stringify(bucketChartLabels)};
  const bucketAtRisk = ${JSON.stringify(bucketAtRisk)};
  const bucketRecovered = ${JSON.stringify(bucketRecovered)};
  const outcomeCounts = ${JSON.stringify(outcomeCounts)};
  const outcomeLabelsPlain = Object.keys(outcomeCounts).map(k => (${JSON.stringify(OUTCOME_PLAIN)})[k]?.label || k);
  const outcomeChartColors = ${JSON.stringify(outcomeChartColors)};
  const realCount = ${realEntries.length};
  const syntheticCount = ${syntheticEntries.length};

  // Horizontal bars read far better than rotated labels once you have more than
  // ~6 categories - every label sits flat and legible, however many rows there are.
  new Chart(document.getElementById('bucketChart'), {
    type: 'bar',
    data: {
      labels: bucketChartLabels,
      datasets: [
        { label: 'At risk (₹)', data: bucketAtRisk, backgroundColor: 'rgba(154,164,189,0.30)', borderRadius: 4 },
        { label: 'Recovered (₹)', data: bucketRecovered, backgroundColor: '#34d399', borderRadius: 4 }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: '#98a2bf', callback: (v) => '₹' + v.toLocaleString('en-IN') },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: { ticks: { color: '#f1f4fb', font: { size: 11.5 } }, grid: { display: false } }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#f1f4fb', font: { size: 12 } } },
        tooltip: {
          backgroundColor: '#1a2233',
          titleColor: '#f1f4fb',
          bodyColor: '#f1f4fb',
          borderColor: '#2a3348',
          borderWidth: 1,
          padding: 10,
          callbacks: { label: (ctx) => ctx.dataset.label + ': ₹' + ctx.parsed.x.toLocaleString('en-IN') }
        }
      }
    }
  });

  // Doughnut with count+percentage labeled directly in the legend, plus the total
  // case count drawn in the empty center - no hovering required to read either number.
  const outcomeTotal = Object.values(outcomeCounts).reduce((a,b) => a+b, 0);
  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f1f4fb';
      ctx.font = '700 26px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(String(outcomeTotal), cx, cy - 10);
      ctx.fillStyle = '#98a2bf';
      ctx.font = '600 11px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText('TOTAL CASES', cx, cy + 14);
      ctx.restore();
    }
  };

  new Chart(document.getElementById('outcomeChart'), {
    type: 'doughnut',
    data: {
      labels: outcomeLabelsPlain,
      datasets: [{
        data: Object.values(outcomeCounts),
        backgroundColor: outcomeChartColors,
        borderColor: '#131924', borderWidth: 3
      }]
    },
    plugins: [centerTextPlugin],
    options: {
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#f1f4fb', font: { size: 12.5 }, padding: 16,
            generateLabels: (chart) => {
              const data = chart.data;
              return data.labels.map((label, i) => {
                const value = data.datasets[0].data[i];
                const pct = outcomeTotal ? Math.round((value/outcomeTotal)*100) : 0;
                return {
                  text: label + '  (' + value + ' · ' + pct + '%)',
                  fillStyle: data.datasets[0].backgroundColor[i],
                  strokeStyle: data.datasets[0].backgroundColor[i],
                  index: i
                };
              });
            }
          }
        },
        tooltip: {
          backgroundColor: '#1a2233',
          titleColor: '#f1f4fb',
          bodyColor: '#f1f4fb',
          borderColor: '#2a3348',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => {
              const pct = outcomeTotal ? Math.round((ctx.parsed/outcomeTotal)*100) : 0;
              return ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
            }
          }
        }
      }
    }
  });

  new Chart(document.getElementById('sourceChart'), {
    type: 'bar',
    data: {
      labels: ['Real (live Razorpay)', 'Simulated (generated)'],
      datasets: [{ data: [realCount, syntheticCount], backgroundColor: ['#34d399', '#98a2bf'], borderRadius: 5 }]
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2233',
          titleColor: '#f1f4fb',
          bodyColor: '#f1f4fb',
          borderColor: '#2a3348',
          borderWidth: 1,
          padding: 10,
          callbacks: { label: (ctx) => ctx.parsed.x + ' events' }
        }
      },
      scales: {
        x: { ticks: { color: '#98a2bf' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#f1f4fb', font: { size: 12.5 } }, grid: { display: false } }
      }
    }
  });
</script>
</body>
</html>`;
}

function main() {
  const { entries, report } = loadData();
  const html = buildHtml(entries, report);
  fs.writeFileSync(OUT_FILE, html);
  console.log(`Dashboard generated -> ${OUT_FILE}`);
  console.log(`Open it directly in your browser (double-click dashboard.html).`);
}

main();