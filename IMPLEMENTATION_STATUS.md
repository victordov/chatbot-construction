# Implementation status

_Last reviewed: 2026-08-06_

## Working end to end

**Multi-tenancy.** Each company has a `widgetKey` and an `allowedDomains` list.
The embed snippet carries the key; `services/tenant.js` resolves it (or the
request Origin) to a company, and every conversation is stamped with that
company on creation. Operators join a per-company socket room
(`operators:<id>`); superadmins join `operators:all`. REST routes are scoped by
`utils/query.js#companyFilter`.

**Chat.** Widget → WebSocket → conversation persistence → AI reply or operator
hand-off, with a REST fallback at `POST /api/chat/message`. End-to-end
encryption uses TweetNaCl served from this origin.

**Visual workflow editor.** `public/js/workflow-editor/editor.js` — a
dependency-free SVG editor. Create, connect, validate, save, publish (with
hot-swap into the live runtime), version history with rollback, duplicate,
delete.

**Workflow runtime.** `services/workflow-compiler.js` compiles the graph to an
execution plan and walks it at request time. Safety and persona prompts are
injected into every LLM node at compile time and cannot be edited out. The
runtime lazily loads a tenant's published workflow on first use, so a restart
does not take every bot offline.

**Knowledge retrieval.** `services/embeddings.js` + `services/vector-store.js`.
Backend is chosen automatically: Qdrant (`QDRANT_URL`), Atlas `$vectorSearch`
(`MONGODB_VECTOR_INDEX`), or MongoDB storage with in-process cosine ranking —
the default, which needs no extra infrastructure. MongoDB is the system of
record in all three, so an external index can always be rebuilt. Vectors carry
the model that produced them and are never compared across models. Sources are
keyed by `(company, sourceId)` so a re-import replaces exactly its own chunks.
Google Sheets, PDF (via `pdf-parse`) and web URL ingestion all produce real
text.

**Intent routing.** `services/intent-classifier.js` scores a visitor's message
against each router condition's example phrases by embedding similarity —
cheaper and more deterministic than LLM classification, and easier to author.

**Plans and billing.** `config/plans.js` defines Trial/Basic/Professional/
Enterprise limits and features. `services/usage.js` meters conversations,
messages, AI replies, uploads, seats, workflows and knowledge chunks;
`middleware/quota.js` enforces them with a 402 carrying the meter, limit and
plan. Superadmins can change a tenant's plan, grant overage, or set
per-company limit overrides.

**Analytics.** Volume, response time, traffic sources, plus bot deflection,
abandonment, a weekday/hour staffing heatmap, per-operator workload with
median and mean response time, recurring topics, and task throughput.
Advanced metrics are gated on the plan's analytics tier.

**File uploads.** MIME allowlist, size cap, random storage ids, tenant-scoped
downloads served as attachments with `nosniff`.

**Operations.** `/health` and `/ready`, Prometheus metrics at `/metrics`,
graceful shutdown, MongoDB-backed sessions, helmet + CSP, rate limiting,
content-hashed widget assets cached for a year with the loader on `no-cache`.

## Known gaps

- **Payment collection is not implemented.** Plans, limits and enforcement are
  complete, but nothing takes money. Integrating a processor means adding a
  webhook handler that calls
  `PATCH /api/billing/companies/:id/subscription` once a payment succeeds —
  that route is the single seam, and it is superadmin-only so a tenant cannot
  grant themselves a plan. Choosing a processor involves PCI-scope decisions
  that belong to whoever operates this.
- **Scanned PDFs yield no text.** `pdf-parse` reads a PDF's text layer; a
  scanned document has none. OCR would need an additional service.
- **In-process vector ranking scans a tenant's chunks** rather than using an
  ANN index. It logs a warning above 20,000 chunks per tenant, at which point
  `QDRANT_URL` or `MONGODB_VECTOR_INDEX` should be configured.
- **Intent matching without an API key falls back to lexical overlap.** With
  `OPENAI_API_KEY` set it is genuinely semantic; without it, "money back" will
  not reach a "refund" intent.
- **Topic analysis is term frequency**, not clustering. It answers "what are
  people asking about" but will not group synonyms.
- **CRM/ticketing integrations** (Salesforce, Zendesk, Shopify) from `todo.md`
  are not built, and there is no public API or webhook system for customers.

## Test suite

`npm test` — 171 tests across 18 suites. An in-memory MongoDB starts
automatically (`tests/globalSetup.js`), so no local `mongod` is needed.
`tests/setup.js` blanks `OPENAI_API_KEY` so the suite never makes a real model
call; the embedding and intent tests therefore assert on ranking and plumbing
rather than on semantic quality.
