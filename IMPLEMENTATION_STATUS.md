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
hand-off. A REST fallback exists at `POST /api/chat/message` for clients that
cannot hold a socket open. End-to-end encryption uses TweetNaCl served from
this origin (`public/widget/js/lib/`).

**Visual workflow editor.** `public/js/workflow-editor/editor.js` — a
dependency-free SVG editor. Create, connect, validate, save, publish (with
hot-swap into the live runtime), version history with rollback, duplicate,
delete. Node types: start, persona, knowledge, llm, response, router,
fallback, operator-handoff, moderation.

**Workflow runtime.** `services/workflow-compiler.js` compiles the graph to an
execution plan and walks it at request time. Safety and persona prompts are
injected into every LLM node at compile time and cannot be edited out from the
editor. The runtime lazily loads a tenant's published workflow on first use, so
a restart does not take every bot offline.

**Admin dashboard.** Active chats, paginated chat history with search, tasks
with comments/activity/follow-ups, notifications, analytics, operator and
company management, widget installation.

**Operations.** `/health` and `/ready`, Prometheus metrics at `/metrics`,
graceful shutdown, MongoDB-backed sessions, helmet + CSP, rate limiting.

## Known gaps

- **Intent-based routing** is not implemented. A router condition of type
  `intent` never matches and falls through to the default branch.
  `contains`, `keyword` and `regex` all work.
- **Vector store search** (`services/knowledge-connector.js`) is written
  against Qdrant but requires `QDRANT_URL`; without it, knowledge nodes fall
  back to no context rather than failing the conversation.
- **PDF extraction** in `extractPdfContent` is a placeholder. Web URL
  extraction works.
- **Analytics** covers volume, response time and traffic sources. The tiered
  analytics in `todo.md` (conversion, segmentation, predictive) are not built.
- **Billing and subscription tiers** from `todo.md` are not built. There is no
  usage metering or plan enforcement.
- **File uploads** post to `/api/upload`, which does not exist as a route. The
  widget's attachment button will fail.
- **Widget versioning**: `services/widgetUpdate.js` manages versions under
  `widget-versions/`, but the served path `/widget/js/widget.js` is not
  version-stamped, so it is served with `no-cache` rather than a long TTL.

## Test suite

`npm test` — 88 tests across 12 suites. An in-memory MongoDB starts
automatically (`tests/globalSetup.js`), so no local `mongod` is needed.
`tests/setup.js` blanks `OPENAI_API_KEY` so the suite never makes a real model
call.
