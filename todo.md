# What is actually left

_Rewritten 2026-08-22; housekeeping updated 2026-09-08._

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

- [ ] **Charge for overage.** `overageAllowed` is honoured by the quota check
      but nothing bills for what it lets through.
- [x] **Nothing starts a checkout from inside the product.** Done server
      side (2026-10): `POST /api/billing/checkout` creates a Checkout Session,
      `POST /api/billing/portal` opens the Billing Portal, and
      `GET /api/billing/me` says which plans can be bought. The dashboard
      buttons arrive with the dashboard rewrite.
- [ ] Automated invoicing, payment reminders, revenue and churn reporting.

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

- [ ] **Google Sheets knowledge documents are stored but not read by the
      assistant.** The import writes spreadsheet rows as knowledge documents;
      neither `services/ai.js` nor a workflow knowledge node searches them.
      Decide whether to embed them into the knowledge base (so a sheet becomes
      chunks like a PDF does) or drop the flow. Until then the README tells
      tenants to use Settings → Knowledge Base.
- [ ] **Invite flow for operators.** A company admin creates operators with a
      password today. An invitation email that lets the operator set their own
      would stop passwords being sent over chat.
- [ ] **Let the assistant choose a capability itself.** `config/capabilities.js`
      and the connector SDK give the platform typed access to a tenant's
      catalogue and diary, but only a workflow author can invoke it by wiring a
      node. Handing the capabilities to the model as tools is the step that
      would let it decide to search the catalogue on its own.
- [ ] **Order lookup** as a connector capability. The contract is shaped so this
      is a new entry in `config/capabilities.js` and a method in the SDK rather
      than new plumbing.
- [x] **Operator-side attachments.** Done server side (2026-10):
      `POST /api/admin/conversations/:sessionId/files` stores the file and
      sends it to the visitor as an operator message, the widget renders it as
      a download chip (thumbnail for images), the visitor downloads it with
      their session token, and visitor uploads now reach operators with
      `fileId`/`fileName`/`fileUrl`. The attach button and transcript
      rendering in the dashboard arrive with the dashboard rewrite.
- [ ] **Loops in workflows.** Any cycle is a hard validation error, so "back to
      the main menu" and "ask again differently" cannot be drawn. The runtime
      already has a step cap that would bound execution.
- [ ] **Republishing a workflow invalidates nothing.** A visitor halfway through
      answering a question resumes against node ids from the old graph.

## Things that need tests

- [ ] `services/backup.js`, `services/scheduler.js` — the operational surface.
      (`services/tenant-backup.js` is covered; the mongodump-based whole-database
      backup is not.)

## Housekeeping

- [ ] **Dependency upgrades.** `express` 4 → 5 and `eslint` 8 (end-of-life) → 9
      with a flat config. Both are mechanical but touch every route file.
- [ ] **9 moderate npm advisories** remain, all transitive: `qs` via
      `express` 4 and `uuid` via `googleapis`. `npm audit --audit-level=high`
      in CI is clean; these clear with the two upgrades above.
- [ ] `googleapis` is 52 major versions behind and is the root of most remaining
      transitive advisories.
- [ ] The admin dashboard loads 23 unbundled script tags, five from a CDN with
      no SRI hashes, and `socket.io` is unpinned — whatever version is latest.

Done since the last rewrite: `.gitignore` is a real one; CI runs lint, tests,
`npm audit` and a Docker build on every push (`.github/workflows/ci.yml`); the
duplicated `api()` helper across the admin modules is being consolidated.
