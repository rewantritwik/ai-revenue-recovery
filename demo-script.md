# Demo Script — AI Revenue Recovery

**Total time: ~4 minutes.** Have `dashboard.html` open in a browser tab before you start.

---

## 1. The hook (20 seconds)

> "Revenue loss rarely happens in one clean step — a payment degrades, a checkout gets
> abandoned, a subscription fails, or an invoice goes overdue. We built an agent that
> closes the whole loop: detect, diagnose the actual root cause, take a bounded
> recovery action, and prove exactly how much money came back."

## 2. Show the architecture, fast (30 seconds)

Point to the pipeline diagram in the README or just say it out loud:

> "Every event — real or synthetic — goes through the same four steps: diagnose the
> root cause, check it against a hard-coded policy table that caps retries and
> amounts, execute exactly one allowed action, and log everything. Nothing outside
> that policy table is allowed to run — that's what makes it bounded."

## 3. The synthetic batch — scale and honesty (60 seconds)

Open `dashboard.html`, point at the top stat cards:

> "This is a 100+ event batch shaped from Razorpay's real documented error
> taxonomy — payment failures, subscription failures, checkout abandonment, and
> overdue invoices. ₹[X] at risk, ₹[Y] recovered."

Point at the **addressable recovery rate** stat specifically:

> "We report two numbers on purpose. The blended rate includes revenue we
> *deliberately refuse* to auto-recover — fraud flags, blocked cards, invoices over
> 30 days overdue that legally need a human, not a bot. The addressable rate is what
> we recovered out of what we were actually allowed to touch. Splitting these out
> is more honest than one number that quietly buries our safety behavior as if it
> were failure."

Point at the bucket chart:

> "Different failure types get different treatment — insufficient funds gets a
> delayed payment link, a timeout gets an immediate retry, a suspected fraud
> signal gets zero auto-action, always a human."

## 4. The real data — this is the differentiator (90 seconds)

Point at the "Live Razorpay test-mode events" table:

> "Everything so far was synthetic. This table isn't — these are real webhooks from
> Razorpay's live test-mode infrastructure. We stood up a real webhook receiver,
> triggered real test payments, and let the system diagnose and act on them with
> zero human intervention."

Walk through one specific real row:

> "This one came back as `international_transaction_not_allowed` — an error code
> our synthetic data never anticipated. The system didn't guess. Low-confidence
> diagnoses get routed to a human queue instead of a wrong action. We then added
> that code to the taxonomy and it now correctly triggers a payment link with
> instructions instead of escalating unnecessarily. That's the system getting
> smarter from live traffic, not just replaying a script."

If you have a `HARD_DECLINE` retry-order real event, mention it:

> "Here's a live one where the agent actually called Razorpay's Orders API and
> created a real retry order in response to a real failure — no human touched
> this."

## 5. The graceful failure (30 seconds)

Find the injected failure case (`evt_00013` in the synthetic batch, or point at any
real `FAILED` outcome):

> "The brief specifically asks for one failure handled gracefully. Here's one:
> the retry itself failed. The system didn't loop, didn't retry indefinitely — it
> logged the outcome honestly and let the batch continue. That's the stopping-rule
> behavior working as designed."

## 6. Close (20 seconds)

> "Every decision here — act or escalate — is explainable, bounded by hard caps,
> and sits in an immutable audit log. We validated it against live Razorpay
> infrastructure, not just a simulation, and it already found and correctly
> handled a real-world edge case we didn't anticipate."

---

## Anticipated questions

**"Is this really connected to Razorpay, or just a nice UI?"**
> "Fully connected — happy to trigger a live failure right now if you want to see
> it end-to-end." (Have your webhook-server + tunnel running as backup if asked.)

**"What happens with subscriptions?"**
> "Architecturally complete — same diagnose/gate/act pipeline — but Subscriptions
> is a separate product that needs activation on the merchant's Razorpay account.
> We validated the logic in the synthetic batch and it's ready to go live the
> moment it's enabled."

**"How do you know your caps are the right caps?"**
> "They're configurable in one file (`config.js`) — a real merchant would tune
> these based on their own risk tolerance. The point isn't that ₹10,000 is the
> right number, it's that there IS a number, and nothing bypasses it."

**"What's the false-positive cost?"**
> Point at the exceptions table: "Every escalation has a stated reason. A human
> reviewing this queue can see exactly why the agent stepped back, which is the
> cost of being conservative — but it's a visible, auditable cost, not a silent one."
