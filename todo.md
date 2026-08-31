# What is actually left

_Rewritten 2026-08-22._

This file used to carry about ninety unchecked boxes covering multi-tenancy,
billing, tasks and analytics. Roughly seventy-five of them had already shipped —
`models/company.js` is the tenant, `config/plans.js` and `middleware/quota.js`
are the billing, `routes/task.js` is the task tracker, `services/analytics.js`
is the analytics. A plan that lists finished work as outstanding is worse than
no plan, because nobody can tell which fifteen items are real.

What is built is described in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
What is left is below.

---

## Money

- [ ] **Take payment.** Plans, limits, metering and enforcement are complete and
      nothing charges anybody. The single seam is
      `PATCH /api/billing/companies/:id/subscription` — a processor's webhook
      calls it once a payment succeeds. Choosing the processor involves
      PCI-scope decisions that belong to whoever operates this.
- [ ] **A superadmin cannot change a tenant's plan from the dashboard.** The
      route above exists and `admin-billing.js` never calls it, so the billing
      design's one seam has no UI.
- [ ] **Charge for overage.** `overageAllowed` is honoured by the quota check
      but nothing bills for what it lets through.
- [ ] Automated invoicing, payment reminders, revenue and churn reporting.

## Per-tenant operations

These two services are still global, from before multi-tenancy:

- [ ] **Retention** — `services/dataRetention.js` has one `retentionPeriod` for
      the whole platform. A tenant with a stricter policy cannot express it.
- [ ] **Backups** — `services/backup.js` is all-or-nothing, so there is no way
      to restore one tenant.

## Support and SLA

- [ ] `prioritySupport` is a boolean in `config/plans.js` that nothing reads.
      Tiered support, SLA guarantees and a priority queue are unbuilt.

## Analytics

- [ ] Enterprise tier: predictive, segmentation, ROI and benchmarking. Basic and
      Professional are done and plan-gated.
- [ ] Topic analysis groups by term frequency, so synonyms stay separate.
- [ ] A data warehouse and real-time processing, if analytics ever outgrows
      running aggregations against the live collections.

## Product gaps worth doing next

- [ ] **A public read API.** Outbound webhooks push events as they happen and
      action nodes call out, but a tenant cannot pull their own conversations or
      contacts — for a backfill, or into a warehouse. Needs API keys with their
      own scoping and rate limits.
- [ ] **Let the assistant choose a capability itself.** `config/capabilities.js`
      and the connector SDK give the platform typed access to a tenant's
      catalogue and diary, but only a workflow author can invoke it by wiring a
      node. Handing the capabilities to the model as tools is the step that
      would let it decide to search the catalogue on its own.
- [ ] **Order lookup** as a connector capability. The contract is shaped so this
      is a new entry in `config/capabilities.js` and a method in the SDK rather
      than new plumbing.
- [ ] **Operator-side attachments.** A visitor can send a file and the operator's
      transcript does not render it — `fileUrl` appears nowhere in
      `public/js/admin_parts/`. There is also no attach button on the operator
      composer, so files only travel one way.
- [ ] **Loops in workflows.** Any cycle is a hard validation error, so "back to
      the main menu" and "ask again differently" cannot be drawn. The runtime
      already has a step cap that would bound execution.
- [ ] **Republishing a workflow invalidates nothing.** A visitor halfway through
      answering a question resumes against node ids from the old graph.

## Things that need tests

- [ ] `websockets.js` is the largest file in the application and the primary
      request path; four tests cover it.
- [ ] `services/task.js` and `routes/task.js` — the whole task, follow-up,
      comment and activity feature, plus a 1,300-line UI, with no direct tests.
- [ ] `services/backup.js`, `services/scheduler.js` — the operational surface.

## Housekeeping

- [ ] `.gitignore` contains the JetBrains template pasted four times (~460
      lines) and one corrupt entry, `.idea/!/security-reports/`.
- [ ] The admin dashboard loads 23 unbundled script tags, five from a CDN with
      no SRI hashes, and `socket.io` is unpinned — whatever version is latest.
- [ ] Eight admin modules each define their own identical `api()` helper, and
      `localStorage.getItem('chatbot-auth-token')` is inlined about forty more
      times.
- [ ] `.github/workflows/ci.yml` is `.disabled`, so nothing runs lint or tests
      on a push, while `docs/ci-cd-pipeline.md` documents the pipeline as though
      it runs.
- [ ] `googleapis` is 52 major versions behind and is the root of most remaining
      transitive advisories. `eslint` 8 is end-of-life.
