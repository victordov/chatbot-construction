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

**Industry neutrality.** Nothing about any particular business is compiled into
the product. A company says who its assistant is (`Assistant` → Persona, or a
workflow's Persona node) and defines its own canned replies, which are matched
to a visitor's message by meaning rather than keyword. A company that
configures nothing gets a plain assistant answering from its knowledge base.

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

**People.** A Contact owns conversations across sessions and devices, so an
operator can see what the same customer asked last week. Identity comes in
three strengths - anonymous, self-reported (they typed an email) and verified
(the tenant signed their user id with an HMAC). Only the last is safe to
discuss account data against, and the dashboard shows which is which.

**Email as a second channel.** A mail provider posts to a per-tenant webhook and
the message lands in the same queue, answered from the same composer, attached
to the same Contact — only delivery differs. Replies thread by `In-Reply-To` /
`References` against Message-IDs we have sent, falling back to sender plus
normalised subject for clients that drop the headers on a forward. Quoted
history is stripped so an operator does not read the thread five times. The
inbound URL is public, so every request must carry the company's inbound
secret; an unknown company and a disabled channel return the same 404 so the
endpoint cannot enumerate tenants.

**Actions in workflows.** A workflow can call the tenant's own API mid-
conversation, so the bot resolves rather than only answers - "where is my
order?" becomes a real lookup. The node branches on whether the call worked,
and only the response fields the author named become variables the rest of the
workflow can use; nothing else from the response reaches the model or the
transcript. Credentials are encrypted at rest and never sent back to the
editor, which sees only that one is set. Because a tenant types a URL that our
server then fetches, the destination is checked at connect time on the resolved
address, including on each redirect - private, loopback and cloud-metadata
ranges are refused. A "Try it" button in the editor runs the call once and
shows both what came back and what the field mappings picked out of it.

**Operator tools.** Saved replies inserted from the composer with `/`, internal
notes that never reach the visitor or the model, conversation transfer with a
handover note, and a queue filtered by All / Mine / Waiting so several chats
can be worked at once.

**Availability.** Per-company business hours in the company's own timezone.
Outside them the widget stops implying someone is about to answer. Whether an
operator is actually connected is read from the socket rooms, so it cannot
drift from reality.

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

`npm test` — 333 tests across 22 suites. An in-memory MongoDB starts
automatically (`tests/globalSetup.js`), so no local `mongod` is needed.
`tests/setup.js` blanks `OPENAI_API_KEY` so the suite never makes a real model
call; the embedding and intent tests therefore assert on ranking and plumbing
rather than on semantic quality.
