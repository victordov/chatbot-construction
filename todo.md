# What is actually left

_Rewritten 2026-08-22; housekeeping updated 2026-09-08; dashboard items closed
2026-10-05; rewritten again 2026-10-22 after the launch-review pass, and the
same day after Phase 2._

This file used to carry about ninety unchecked boxes covering multi-tenancy,
billing, tasks and analytics. Roughly seventy-five of them had already shipped —
`models/company.js` is the tenant, `config/plans.js` and `middleware/quota.js`
are the billing, `routes/task.js` is the task tracker, `services/analytics.js`
is the analytics. A plan that lists finished work as outstanding is worse than
no plan, because nobody can tell which fifteen items are real.

What is built is described in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
What is left is below. Phase 2 built most of what the October launch review
put in "the next ninety days" (booking, the messaging apps, the operator app
and push, JWT identity and email codes, the WordPress plugin and Shopify
snippet, MCP, agencies, per-resolution pricing); what it left open is here,
with everything older that is still open.

---

## Before anyone relies on Phase 2

- [ ] **Try each integration against the real service once.** None has been:
      a Meta app (WhatsApp, Messenger, Instagram, both directions, a
      template, the Human Agent tag), Cal.com, Google Calendar, Calendly
      (paid and free plans), a Stripe Billing Meter through to an invoice,
      a real MCP server of each protocol era, push delivered to an Android
      phone, an iPhone and a desktop, and the WordPress plugin and Shopify
      snippet on real sites. The steps are in
      [docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md); write down
      what each first setup turns up.
- [ ] **Per-resolution billing against Stripe**: that the meter's monthly
      total matches Plan & billing, that a lowered cap (which reports a
      negative difference for the day) produces the right invoice, and that
      late resolutions reach last month's invoice within the grace period.
- [ ] **Decide the prices.** `PLAN_AGENCY_*` and `PRICE_PER_RESOLUTION*` are
      placeholders read from the environment.

## Non-code work with outside parties

- [ ] **Meta**: business verification and App Review (`pages_messaging`,
      `instagram_manage_messages` at Advanced Access; Human Agent) for any
      Meta app we provide to tenants rather than they bring.
- [ ] **Google OAuth verification** of the Calendar client (its scopes are
      sensitive; until verified only listed test users can connect, and
      Google documents seven-day refresh tokens for apps in Testing).
- [ ] **Store listings**: the WordPress plugin on WordPress.org and a Shopify
      app in the Shopify App Store. Today both are downloads from the
      dashboard, which is not how Tidio and Gorgias reached their customers.
- [ ] **SOC 2** and an **EU region**. GDPR tooling is real (export, erase,
      consent, per-tenant retention); the deployment is one region.

## Reaching customers where they are

- [ ] **Messaging apps: files, languages, typing.** Operators cannot send an
      attachment to a WhatsApp, Messenger or Instagram customer; the notices
      the platform sends there are English only; no typing indicator is sent.
- [ ] **Ordering across instances.** A unique index keeps one open
      conversation per messaging-app customer, but two messages from one
      customer arriving at once on different instances are still handled side
      by side (the lock in `services/channels/inbound.js` is per process), so
      the bot can answer both at once, in either order.
- [ ] **Booking**: reminders in the visitor's language (they are English);
      self-hosted Cal.com (the API address is fixed to Cal.com's cloud).

## Knowing who the visitor is, and reaching their systems

- [ ] **MCP from workflows, and OAuth MCP servers.** A tool can be set to
      "workflow only", but no workflow node can call one yet, and servers
      that need an OAuth sign-in cannot be connected.
- [ ] **Use signed attributes.** A JWT's `attrs` are stored and shown in
      People, but an action input can only take the verified id, email, name
      or phone, and workflows do not see them (docs/PRODUCT.md
      recommendation 2 asked for both).
- [ ] **JWT on the REST fallback.** `POST /api/chat/message` accepts only the
      HMAC pair; the socket takes either.
- [ ] **Ask a visitor to verify from the inbox.** `visitor-verification.askVisitor`
      opens the code form in the visitor's chat but nothing calls it; today
      only the assistant offers verification.
- [ ] **Order lookup** as a connector capability. The contract is shaped so this
      is a new entry in `config/capabilities.js` and a method in the SDK rather
      than new plumbing.
- [ ] **Google Sheets: decide.** The import writes spreadsheet rows as
      knowledge documents that neither the assistant nor a workflow knowledge
      node reads. The card is hidden unless `GOOGLE_SHEETS_UI=true` and the code
      is kept until the owner decides. The options are in docs/PRODUCT.md §5
      (index each row as a chunk; later, a sheet lookup action). A sheet saved
      as CSV and uploaded to Bot → Knowledge is answered from today.

## Money

- [ ] **Charge for overage.** `overageAllowed` is honoured by the quota check
      but nothing bills for what it lets through.
- [ ] **Bill an agency's extra clients.** Clients beyond the included ones are
      counted and priced on the Clients screen; nothing sends them to Stripe.
      (Clients go on the paid client plan only once the agency's own Agency
      plan is active and paid; on a trial they start on their own trials.)
- [ ] Automated invoicing reminders, revenue and churn reporting. (Invoices
      are listed from Stripe; usage warnings at 80% and 100% exist.)

## Support and trust

- [ ] `prioritySupport` is a boolean in `config/plans.js` that nothing reads.
      Tiered support, SLA guarantees and a priority queue are unbuilt.

## Analytics

- [ ] Enterprise tier: predictive, segmentation and benchmarking. Basic,
      Professional and the value report are done.
- [ ] Topic analysis groups by term frequency, so synonyms stay separate.
- [ ] A data warehouse and real-time processing, if analytics ever outgrows
      running aggregations against the live collections.

## Product gaps

- [ ] **Loops in workflows.** Any cycle is a hard validation error, so "back to
      the main menu" and "ask again differently" cannot be drawn. The runtime
      already has a step cap that would bound execution.
- [ ] **An operator reply sent in the seconds before the server notices a
      visitor left goes to the chat, not email.** The switch is made on
      whether the visitor still has a socket, and a dropped connection lingers
      until the ping timeout.
- [ ] **Translate the dashboard.** The widget speaks eleven languages; the
      dashboard is English only.

## Things that need tests

- [ ] `services/backup.js`, `services/scheduler.js` — the operational surface.
      (`services/tenant-backup.js` and the sweeps the scheduler runs are
      covered; the mongodump-based whole-database backup and the cron wiring
      are not.)

## Housekeeping

- [ ] **Dependency upgrades.** `express` 4 → 5 and `eslint` 8 (end-of-life) → 9
      with a flat config. Both are mechanical but touch every route file.
- [ ] **Moderate npm advisories** remain, all transitive: `qs` via `express` 4
      and `uuid` via `googleapis` (nine when last counted, 2026-09).
      `npm audit --audit-level=high` in CI is clean; these clear with the
      upgrades.
- [ ] `googleapis` is 52 major versions behind and is the root of most remaining
      transitive advisories. It is now also what Google sign-in uses. (Google
      Calendar booking does not use it; it calls Google over plain HTTPS.)

---

## Done since the last rewrite

- [x] **Native calendar booking** (Phase 2): Cal.com, Google Calendar and
      Calendly under Bot → Booking, with reminders, cancellation by
      reference and operator cancel/move.
- [x] **WhatsApp, Messenger and Instagram** into the same inbox (Phase 2).
- [x] **Operator app**: an installable PWA with Web Push (Phase 2).
- [x] **A WordPress plugin and a Shopify snippet**, downloadable pre-filled
      from the dashboard (Phase 2; store listings still open, above).
- [x] **Agency and white-label** (Phase 2): agencies, clients, working in a
      client's dashboard on the record, and the agency's brand.
- [x] **JWT identity and an in-chat email code** (Phase 2).
- [x] **MCP client** with per-tool switches and the Actions guards (Phase 2).
- [x] **Outcome pricing**: Professional per resolution with a spending cap,
      reported to a Stripe Billing Meter (Phase 2).
- [x] **Hand-overs carry a summary** ("Asked: …", the visitor's last three
      messages), **long waits alert the team**, and **idle web chats end**,
      so `conversation.ended` fires for bot-only conversations (Phase 2).
- [x] **Self-serve sign-up** (`/admin/signup.html`), email confirmation,
      Google sign-in for existing accounts, and a Home checklist that ticks
      from what actually happened.
- [x] **Invite flow for operators and admins.** An email with a link where
      they choose their own password; resend and withdraw; the admin gets the
      link when the email cannot go. A superadmin creating a company invites
      its first admin the same way.
- [x] **Republishing a workflow restarts a half-finished one.** Workflow state
      carries on only within the same live version, so a visitor halfway
      through a question starts afresh after a republish instead of resuming
      against node ids from another graph. Editing a live workflow now makes
      a draft that visitors do not see until it is published.
- [x] **Several live workflows**, each with a trigger, with the assistant
      answering whatever none of them takes.
- [x] **Widget preview at desktop width.** Channels → Website widget has a
      desktop/phone toggle.
- [x] **A widget JavaScript API** (`window.ChatWidget`), a proactive message,
      consent, suggested questions, and an AI disclosure in eleven languages.
- [x] **Unanswered questions, Teach the bot and saved tests**: the loop that
      tells a tenant what their bot does not know and stops it forgetting what
      it learned.
- [x] **Knowledge refresh**: background crawls with progress, a weekly re-read
      per site or page, and pages that disappear from a site are dropped.
- [x] **Value report** on every plan, with a published definition of
      "resolved by the bot".
- [x] **Sign out of one device**, and "sign out on every device".
- [x] Earlier: in-product checkout and the Billing Portal, operator-side
      attachments, the Actions screen and the editor's saved-action picker,
      the assistant choosing actions and connector capabilities itself, the
      dashboard bundled with no third-party origin, a real `.gitignore`, CI
      running lint, tests, `npm audit` and a Docker build on every push, and
      one HTTP client in `client/shared/http.js`.
