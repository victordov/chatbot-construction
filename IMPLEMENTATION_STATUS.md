# Implementation status

_Last reviewed: 2026-09-08_

## Working end to end

**Multi-tenancy.** Each company has a `widgetKey` and an `allowedDomains` list.
The embed snippet carries the key; `services/tenant.js` resolves it (or the
request Origin) to a company, and every conversation is stamped with that
company on creation. Operators join a per-company socket room
(`operators:<id>`); superadmins join `operators:all`. REST routes are scoped by
`utils/query.js#companyFilter`.

**Chat.** Widget → WebSocket → conversation persistence → AI reply or operator
hand-off, with a REST fallback at `POST /api/chat/message`. Transport
security is TLS between the browser and the server. The widget no longer
claims end-to-end encryption: the server has to read every message to answer
or route it, so the in-browser key exchange it used to do promised something
the design cannot deliver, and it was removed rather than left to mislead.

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
does not take every bot offline. `services/reply.js` is the single seam both
the socket handler and the REST fallback go through: a published workflow
answers if the tenant has one, the assistant otherwise, and a workflow that
fails falls back rather than leaving a visitor with silence.

**Conversations, not single replies.** A workflow can ask a question, wait, and
use the answer: where it got to is kept on the conversation, so the next message
resumes instead of starting again. Answers are validated by format, a wrong one
is asked for again a few times, and then the flow takes its "could not answer"
path rather than trapping somebody in a loop. Choice nodes render as buttons in
the widget and are matched tolerantly — the tap, the label, or the number all
work. Beyond that: branch on a value rather than on what the visitor said,
compute a value, branch on whether anyone is actually available, tag the
conversation, raise a task carrying everything the flow collected, and email the
team. A check node takes several comparisons combined with all/any, which is
what nearly every real condition turns out to be. There is deliberately no code
node: running tenant-supplied JavaScript in this process would need a sandbox
that does not exist here, and clauses cover what people reach for it for.

**Trying a workflow before publishing it.** Until this existed, the only way to
find out whether a twelve-node flow worked was to publish it to real visitors
and watch — which is how bad bots ship. The editor now runs the graph on the
canvas, saved or not, as a real multi-turn conversation, and lights up the nodes
it passes through so "why did it say that" is answered by looking rather than by
reading the graph backwards. The canvas follows the run, because a flow ends on
the right and that is where the panel sits.

Previews read but do not write. A GET really happens — that is what makes the
branches worth testing, since they are being tried against what the API actually
returns — but a POST, a task, a tag and an email are declined and reported as
"would have". An author testing a branch six times must not leave six tickets
behind, or they stop testing.

**A tenant's own data, through the connector SDK.** `sdk/` is a package a
tenant installs. They implement the methods that apply to their business —
search the catalogue, get a product, list free appointment times, book one —
and expose the result at one URL. Everything fiddly is handled for them:
verifying the request came from us in constant time with a five-minute window,
answering discovery so nobody maintains a list by hand, and shaping what their
methods return so a mistake is a clear message at their end rather than a blank
card at ours.

The point of fixed shapes rather than another Call an API node is what becomes
possible once we know what we are holding: the widget renders product cards with
pictures and prices, and appointment times as buttons somebody taps. Reads are
cached briefly and may run in a preview; writes never do, because testing a
booking branch six times must not fill somebody's diary. The URL is one a tenant
typed, so it goes through the same address-checked transport as everything else
— and when that refuses a localhost address, it says to use a tunnel rather than
just refusing.

**Workflow templates.** Eight complete flows a tenant can start from — order
status, returns, front-desk triage, lead qualification, appointment booking,
verified account lookup, cancellation, and complaint handling — rather than a
blank canvas. Each says up front what it needs before it will work, every one
checks whether a person is available before promising one, and every one has a
way out to a human. There is a test that they all still validate.

**Integrations by recipe, not by connector.** The Call an API node already
reaches any HTTP service; what stops a tenant is knowing each API's shape. Five
presets — Shopify, Stripe, Zendesk, Slack and HubSpot — fill in the URL, method,
authentication style and field mappings, and say where the credential comes
from. No per-service code exists in the runtime, so there is nothing to break
when a vendor changes anything other than the recipe.

**Knowledge, end to end.** Until recently this loop did not close: ingestion,
embedding, storage and retrieval were all built and *nothing called any of it*.
No route in the product invoked `processKnowledgeSource`, so `KnowledgeChunk`
was empty in every real deployment and both readers searched nothing and found
nothing, without ever erroring. A tenant could not put a single sentence into
their own knowledge base.

`routes/knowledge.js` is the way in, and **Settings → Knowledge Base** is the
screen: import a web page or a PDF, or paste text straight in; see what is
indexed and how big it is; ask a test question to find out what the bot will
retrieve before a customer does; remove a source. A re-import replaces exactly
its own chunks. The URL is one a tenant typed, so fetching it goes through the
same address-checked transport as workflow actions and webhooks — a knowledge
import cannot be aimed at the instance metadata service.

**More ways in: files and whole sites.** `POST /api/knowledge/upload` takes a
file (multipart field `file`, optional `title`): PDF, plain text, Markdown, CSV
or HTML, up to `KNOWLEDGE_UPLOAD_MAX_BYTES` (10 MB). The type is decided from
the bytes as well as the name, so a zip renamed `.csv` is a 415 rather than
several hundred chunks of noise; the file is read in memory and never written
to disk. A CSV is indexed whole rows at a time, each written as `Header: value`
lines, so a chunk retrieved alone still says which number is the price. The
source is keyed by file name (`file:<name>`), so uploading a new `prices.csv`
replaces the old one. Parsing lives in `services/knowledge-files.js`.

`POST /api/knowledge/crawl` (`{url, maxPages}`) reads a site: `/sitemap.xml`
first (sitemap indexes followed a level), then links from the pages, breadth
first, same origin only, HTML only, capped by `KNOWLEDGE_CRAWL_MAX_PAGES` (50;
a request defaults to 20) and `KNOWLEDGE_CRAWL_TIME_BUDGET_MS` (60 s). Every
fetch — sitemap, pages, every link a page wrote — goes through `safe-http.js`.
Each page becomes its own `url:` source with its `<title>`, exactly as if it
had been imported by hand, so refresh and delete work per page and a second
crawl replaces rather than doubles. The answer lists what was imported and
what was skipped and why (not HTML, fetch failed, time ran out, plan limit).
Crawling lives in `services/knowledge-crawler.js`. Single-URL imports now keep
the page's `<title>` too.

Both readers now work. `services/ai.js` retrieves on every assistant reply, so a
company that has imported their material gets answers from it without drawing a
workflow — which is what uploading it implied in the first place. Inside a
workflow, `runLlmNode` sent `step.data.systemPrompt || systemPrompt` where the
left branch was always set by the compiler, silently discarding the knowledge it
had just retrieved; it now sends the built hierarchy.

**Citations.** An assistant reply says which sources it drew on.
`reply.generate()` returns `sources: [{title, url}]` — the sources of the chunks
actually placed in the prompt, one entry per source, best first, at most three;
`url` is null for pasted text and uploaded files. A canned reply, an apology
and a workflow reply cite nothing (the workflow compiler does not report which
chunks its knowledge node used). The socket `bot-message` event and the REST
reply carry `sources` next to the text (always an array), the bot message
stores it (`messages[].sources`), operators' `new-message` carries it, and
`GET /api/chat/history` returns it, so a reload shows the citations again.

**"Test your bot".** `POST /api/bot/test` (`{message, history, useWorkflow,
state?}`, company admin; superadmin names `companyId`) runs the real reply
path — published workflow, canned replies, assistant — for the tenant and
answers `{reply, sources, path: workflow|canned|assistant|fallback, choices?,
cards?, escalate?, state?, warning?}`. Nothing is created or counted: no
Conversation, no usage meters, no canned-reply use count, and a workflow runs
in the editor preview's simulate mode, so a GET happens but a task, tag,
email, POST or handoff is declined. Without `OPENAI_API_KEY` it answers what a
visitor would get (the apology) with `warning: 'OPENAI_API_KEY is not set'`.
The returned `state` lets a workflow that asked a question be answered on the
next turn; identity variables are stripped from it, as in preview.

**Setup checklist data.** `GET /api/companies/me/setup` answers, from cheap
counts and flags, how far a tenant has got: knowledge sources and chunks,
persona (Assistant persona or a Persona node in the live workflow), allowed
domains, conversations (`widgetSeen` when there is at least one), active
operators including admins, a published workflow, email channel and business
hours.

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

**Actions the assistant chooses itself.** A saved Action (`models/action.js`,
`/api/actions`) is that same request defined once: a slug name, a "when to use
this" description the model reads, typed inputs that come from the visitor,
from the verified contact, or from a constant, an encrypted credential
(responses only ever say `hasCredential`), a raw-JSON-with-a-cap or
mapped-fields response mode, an `auto` / `workflow_only` switch and a
"requires verified" gate. `POST /api/actions/:id/test` runs it once; `GET
/api/actions/presets` turns the editor's five service recipes into templates.
When the assistant answers (`services/assistant-tools.js`, one seam in
`services/ai.js`), every enabled `auto` action and each enabled connector
capability is offered to the model as a tool. The rules are enforced server
side: verified-only actions are not offered to unverified visitors and
verified inputs never come from the model's arguments; a write (non-GET, or a
`write` capability) is stored as `conversation.pendingAction` and runs only
when the identical call is repeated in a later turn after an affirmative
reply, within ten minutes; at most three calls and one write per turn; results
are truncated and fenced as data; failures go back to the model as one line;
every call that ran is in the audit log as `assistant.tool_called`. Catalogue
and slot results come back as `cards` / `choices` exactly as the workflow
capability node produces them. A workflow action node can reference a saved
action with `actionId` instead of carrying its own request. Plans: the
`actions` feature and meter (Trial 5, Professional 25, Enterprise unlimited,
Basic none).

**Satisfaction.** A visitor is asked to rate the conversation once it ends, if
they sent more than one message; declining is remembered so nobody is asked
twice. The score is recorded on the first tap and a comment box only then
appears, so a rating is never lost to someone who did not want to write an
essay. Credit is read from the transcript rather than from the conversation's
operator fields, which ending a chat clears. Reported as the share satisfied
with its sample size and response rate beside it — and deliberately next to
deflection, because a deflection rate on its own rewards a bot that is merely
hard to escape. The headline is available on every plan; the per-operator split
and the comments are part of the advanced report.

**Routing and tags.** A visitor can ask for a person with a button rather than
by hoping the bot notices, and the conversation goes to whoever is online and
carrying the least, with the person who has waited longest going first when
that ties. Nobody is handed more than their limit — the company's, or their own
if they have one — and an operator can stop taking new work without
disconnecting. Nobody available is a normal outcome: the conversation waits in
the queue, and the visitor is told so rather than left watching an empty window.
Conversations carry free-form tags, suggested from the ones already in use, and
the queue can be filtered by them.

**Outbound webhooks.** The platform can now tell a tenant's systems what
happened here, which is what stops it being a silo: a conversation ended, a
customer rated it, a lead qualified itself, a person was verified. Deliveries
are signed HMAC-SHA256 over the timestamp *and* the body, so a receiver that
rejects old timestamps is protected against replay, and the dashboard shows the
verification recipe at the one moment somebody is holding the secret. Failures
are retried with a growing delay up to roughly two hours; retries are rows with
a time on them rather than timers in memory, so a deploy does not lose them.
A 4xx is not retried because retrying will not fix it; a 429 is. An endpoint
that fails twenty times in a row is switched off with a reason rather than
retried forever. Every attempt is logged with what was sent and what came back,
which is the difference between a webhook system somebody can integrate against
and one that generates support tickets. The URL is one a tenant typed, so it
goes through the same address-checked transport as workflow actions.

**Audit log.** Who signed in, who failed to, who changed a role, deleted a
conversation, published a workflow, rotated the identity secret, changed a
plan, or exported and erased somebody's data. Append-only — there is no route
anywhere that edits or deletes an entry, because a record that can be rewritten
is not evidence. Credentials never reach it: field names that look like secrets
are redacted before writing, so the log does not become the most sensitive
collection in the database. A company admin sees their own company's history;
platform-level events belong to whoever operates the platform. Entries expire
on a configurable retention window (`AUDIT_RETENTION_DAYS`, 400 by default),
which the page states rather than implying they are kept forever.

**Operator tools.** Saved replies inserted from the composer with `/`, internal
notes that never reach the visitor or the model, conversation transfer with a
handover note, and a queue filtered by All / Mine / Waiting so several chats
can be worked at once.

**Availability.** Per-company business hours in the company's own timezone.
Outside them the widget stops implying someone is about to answer. Whether an
operator is actually connected is read from the socket rooms, so it cannot
drift from reality.

**A public read API.** Webhooks push events as they happen; nothing let a
tenant pull their own data — for a backfill, into a warehouse, or for a report
of their own. `/api/v1` does, read-only, authenticated by keys a company admin
creates for themselves. Scopes are per resource, because a warehouse sync that
needs conversations has no business holding a credential that also reads
contacts. A key is shown once and stored as a hash, so a database dump is not a
set of live credentials; revoked keys stay in the list, since after an incident
the record that a key existed and when it was last used is exactly the point.
Paging is by cursor rather than page number: an offset shifts while new
conversations arrive, and a sync that silently skips rows is worse than one
that fails. Records are shaped explicitly rather than handed over as stored
documents, so no future migration adds a field to the API by accident. The
plan's `apiAccess` is checked per request rather than at creation, so a
downgrade takes effect instead of leaving old keys working forever, and the
limiter counts per key — one program looping is not a reason to throttle the
tenant's own dashboard.

**Taking money.** Plans, limits, metering and enforcement were complete and
nothing charged anybody. Stripe now does: the customer pays on Stripe's own
page, so card details never reach this server and the PCI surface stays where
it belongs, and `POST /api/billing/webhook/stripe` moves the tenant onto the
plan they bought. There is no Stripe library — verifying a signature and
reading five event types is less code than keeping a dependency current — and
the signature is the whole authentication for a public endpoint, so it is
checked against the raw bytes Stripe signed (the parsed-and-reserialised body
can never match, which is the classic way this is got wrong, and it fails
closed). Replays outside a five-minute window are refused, and an event older
than one already applied is ignored, so a redelivered "payment failed" from
Tuesday cannot land after Wednesday's "payment succeeded" and suspend a tenant
who is paid up. A price with no configured plan leaves the tenant where they
are rather than guessing; an unrecognised event and an unmatchable customer are
acknowledged rather than refused, because an endpoint that keeps failing gets
disabled by Stripe and takes the events that do matter with it. A failed
payment is `past_due`, which still entitles the tenant — cutting off a support
desk the moment a card expires punishes their customers, not them. Both the
webhook and the superadmin's plan dialog go through one function, because two
implementations of what a plan change means would eventually disagree about
what somebody is charged.

**A backup that can restore one customer.** `mongodump` answers "we lost the
server"; it answers "one customer lost their data" appallingly, because rolling
every tenant back to last night to undo one company's mistake trades their bad
day for everybody else's. Alongside it there is now a document-level export of
one company — written as EJSON, so ids and dates come back as ids and dates
rather than as strings. What belongs to a tenant is read from the schemas
rather than from a list, so a new tenant-scoped model is covered the day it is
added; what hangs off a parent instead (a comment on a task, a version of a
workflow) is declared, and anything in neither category is named in the
manifest as uncovered, because a backup whose edges you cannot see is not one
to rely on. Restoring merges by default and so cannot itself delete anything;
the mode that makes a tenant match the backup exactly has to be asked for with
the company's name typed out. The audit log is exported and never restored — a
restore that could rewrite the record of what happened is not an audit log. Two
things are checked because the tool is used on somebody's worst day: a backup
carrying another company's id is refused, and every query is scoped to the one
tenant, so a restore cannot reach a neighbour. Nightly backups are opt-in
(`TENANT_BACKUPS_ENABLED`), since deciding where a tenant's data gets written
belongs to whoever operates the platform.

**Retention each tenant sets for themselves.** There was one number for the
whole platform, so a tenant who had promised their customers ninety days could
not honour it, and a tenant obliged to keep seven years lost the data anyway. A
company now sets its own two windows — anonymise after so many days, delete
after so many more — with the platform's numbers as the fallback and 0 meaning
never, which is a different statement from not having chosen. Anonymising is
the stage that was missing: `Conversation.anonymize()` did not exist, so the
one code path that called it would have thrown the first time it ran. It now
strips the transcript, the addresses, the contact link and the free-text rating
comment while keeping timings, roles and scores, because a report covering last
year still needs a last year to cover. The screen shows what a policy would
delete tonight before it is saved, deleting before anonymising is refused as
incoherent, and a change is written to the audit log — shortening a window
destroys data on a schedule, and somebody has to answer for having chosen it.
One tenant's failure does not stop the sweep reaching the others.

**Rate limiting that survives a second instance.** Counts live in MongoDB
rather than in each process's memory, so "5 login attempts an hour" does not
quietly become fifteen behind three replicas — the limits used to multiply by
the instance count, and nothing about the configuration changed when somebody
scaled the deployment. The key is the tenant wherever the request proves which
tenant it is: authenticated traffic carries a signed token, so it is keyed by
company and user and an office NAT stops being one shared bucket, and the
allowance comes from the plan (`apiRequestsPerMinute`, overridable per company
like every other limit). Anonymous traffic proves nothing — a widget key is
public by construction — so it is used only to separate tenants and never as
the whole key, or anyone wanting a fresh bucket would invent one. Login is
counted per address *and* account, and only failures count. A superadmin is
skipped, because an incident nobody can log in to fix is worse. If MongoDB is
unreachable the store counts in memory rather than failing the request or
opening the door.

**File uploads.** MIME allowlist, size cap, random storage ids, tenant-scoped
downloads served as attachments with `nosniff`.

**Operations.** `/health` and `/ready`, Prometheus metrics at `/metrics`,
graceful shutdown, MongoDB-backed sessions, helmet + CSP, rate limiting,
content-hashed widget assets cached for a year with the loader on `no-cache`.
Background jobs are gated by `SCHEDULER_ENABLED` so a multi-instance
deployment runs them once. There is a `Dockerfile`, a Compose file that runs
the app with MongoDB 7, and CI that runs lint, tests, `npm audit` and the
image build on every push. The first superadmin is created through
`POST /api/auth/create-superadmin`, which works only while no user exists.

## Known gaps

- **Nothing starts a checkout from inside the product.** Stripe tells us what
  happened once somebody has paid, but the tenant reaches Stripe by a Payment
  Link somebody sent them rather than by an upgrade button here.
- **Nothing bills for overage.** `overageAllowed` lets a tenant exceed their
  plan and nothing charges for what it let through.
- **A crawl follows no robots.txt and reads no JavaScript.** It reads the HTML
  a server returns, so a site rendered in the browser yields little text. It
  is same-origin by the address it was asked for; a page that redirects
  off-site is followed (through the same address checks) and imported under
  the address that was asked for.
- **A re-crawl does not remove pages that have gone from the site.** Each page
  crawled again is replaced, but a page that no longer exists stays until it is
  deleted by hand: a crawl stopped by its cap or time budget cannot tell
  "removed" from "not reached".
- **Knowledge has no scheduled re-sync.** Refresh is per source, by hand.
- **Workflow replies carry no citations.** The compiler's knowledge node does
  not report which chunks it used, so `sources` is always empty for them.
- **"Test your bot" runs real model and GET calls.** Those cost what they cost
  (they are not metered against the tenant's plan, but OpenAI bills them), and
  the runtime's in-memory execution counter moves. Persona changes reach it
  after the assistant-config cache (60 s), canned replies immediately.
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
- **The connector covers catalogue and appointments only.** Carts, checkout and
  order lookup are the obvious next capabilities; the contract and SDK are
  shaped so adding one is a new entry in `config/capabilities.js` and a method
  in the SDK rather than new plumbing.
- **Actions have no dashboard screen yet.** `/api/actions` is complete (CRUD,
  test panel, presets) and the assistant uses saved actions as tools, but the
  dashboard is being rewritten and has no form for them; the workflow editor
  does not offer `actionId` on the action node either. Until then actions are
  created through the API.
- **Write confirmation is lexical.** A write runs only when the model repeats
  the identical call in a later turn after a reply that matches a short list of
  affirmatives ("yes", "ok", "go ahead"…, with no negation). That is
  deliberately strict and deterministic, but a confirmation in another
  language, or phrased unusually, is read as "not yet" and the visitor has to
  say yes plainly.
- **No MCP client and no in-chat one-time code yet.** A visitor becomes
  verified only through the tenant's signed `identify` call, so actions marked
  "requires verified" are invisible to anonymous visitors with no way for them
  to verify inside the chat (PRODUCT.md recommendations 2 and 3).
- **A workflow cannot call another workflow**, and there is no loop construct.
  Both are deliberate for now: cycles are rejected at design time because the
  executor walks the graph, and a conversation that loops is almost always a
  bug rather than an intention.

**Alerts that describe the system.** `services/alerting.js` reads the
Prometheus registry that `services/monitoring.js` has always populated. It used
to read `Math.random()`: average response time was `Math.random() * 3000`
against a 2000ms threshold and error rate `Math.random() * 0.1` against 5%, so a
deployment with alerts enabled sent a warning about one check in three and a
*critical* "High Error Rate" email about half the time, forever, unrelated to
anything that had happened. Each check now measures the interval since the last
one rather than the lifetime of the process, so a bad minute does not stay in
the average and a bad hour actually moves it. No traffic means no claim: a quiet
window neither raises nor resolves anything.

**Data-subject requests that find the person.** The GDPR routes looked
conversations up by `Conversation.userId`, a field nothing in the application
ever writes. Every request matched nothing, so the export produced an empty file
and the erasure answered `success: true, "Deleted 0 conversations"` while
writing an audit entry recording that an erasure had been performed. A subject
is now resolved by contact id (covering every session that person has had), by
session id, or by the legacy `userId`; an identifier that matches nobody is a
404 rather than a false confirmation.

## Test suite

`npm test` — 731 tests across 39 suites. An in-memory MongoDB starts
automatically (`tests/globalSetup.js`), so no local `mongod` is needed.
`tests/setup.js` blanks `OPENAI_API_KEY` so the suite never makes a real model
call; the embedding and intent tests therefore assert on ranking and plumbing
rather than on semantic quality.

The socket layer and the task feature are covered directly now. `websockets.js`
had four tests that mocked the database, the encryption service, the model and
JWT, and the last of them called `done()` from a one-second timeout — it passed
whether or not the server replied at all. Its replacement runs a real server
against a real database over the real socket protocol, and stubs only what the
model would say. Tasks had no direct tests at all, and writing them turned up
two defects: a follow-up looked its parent up unscoped, so an operator at one
company could hang a task off another company's — inheriting that company, their
conversation and the customer's name, email and phone number — and every task
deletion threw inside the activity logger and was swallowed, so the one action
most worth a trace left none.

## Removed on 2026-09-08

Each of these was deleted rather than fixed. One line on why:

- **Widget "end-to-end encryption"** (`docs/encryption.md`, the widget's
  `encryption.js`): the server decrypted every message to answer it, so the
  claim was untrue and the code was cost without benefit.
- **Widget versioning** (`services/widgetUpdate.js`, `widget-versions/`,
  `tests/widget-versions.test.js`): four copies of the widget on disk and a
  version manifest nothing consumed; the widget is served content-hashed from
  `public/widget` instead.
- **Operator assist** (`services/operator-assist.js`): an unwired suggestion
  service with no route or UI calling it.
- **REST session API** (`routes/session.js`): the socket layer owns sessions;
  the route duplicated it without tenant scoping.
- **`create-admin.js`**: created a superadmin with a published default password;
  replaced by `POST /api/auth/create-superadmin`, which only works while no
  user exists.
- **`services/googleDrive.js`, `services/documentIndex.js`,
  `models/knowledge-source.js`**: the pre-knowledge-base Drive indexer,
  superseded by `routes/knowledge.js` and `services/knowledge-connector.js`.
- **Cookie consent banner** (`public/js/cookie-consent.js`, its CSS): the
  widget sets no tracking cookies, so it asked consent for nothing.
- **Load-test and security-audit reports, `scripts/load-test.js`,
  `scripts/setup-monitoring.sh`, `public-setup.js`,
  `test-activity-tracking.js`, `ACTIVITY_TRACKING_IMPLEMENTATION.md`**:
  one-off scripts and their 2025 outputs, committed by accident.
- **Mock database helpers** (`tests/helpers/mock-db.js`,
  `tests/helpers/mock-mongodb.js`): the suite runs against an in-memory
  MongoDB now, so the mocks only let tests pass that should not have.
- **Stale design documents** (`docs/ci-cd-pipeline.md`,
  `docs/security-audit-*.md`, `docs/integration-testing-strategy.md`,
  `docs/VISUAL_WORKFLOW_EDITOR_IMPLEMENTATION.md`,
  `docs/WORKFLOW_EDITOR_COMPLETE.md`): described pipelines and plans that did
  not match what runs. `docs/DOCKER.md` and `docs/GOOGLE_OAUTH_SETUP.md`
  remain and are current.
