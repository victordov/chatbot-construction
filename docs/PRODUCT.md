# Product overview

_Written 2026-09-09 from the working tree on `production-readiness`. Companion documents: [FUNCTIONALITY_MAP.md](FUNCTIONALITY_MAP.md) (every endpoint, socket event, model and setting, read from the code), [research/market-landscape-2026-09.md](research/market-landscape-2026-09.md) (sixteen competing products, with sources) and [research/customer-data-connection-2026-09.md](research/customer-data-connection-2026-09.md) (how those products let an AI agent reach a customer's own systems, with sources)._

## 1. What the product is

A customer-support platform a business embeds on its own website. Three things work together:

- **An AI assistant** that answers visitors from the business's own material (web pages, PDFs, pasted text) in the persona the business defines, and knows when to hand over.
- **A visual workflow builder** for the conversations that must follow rules: ask for an order number, look it up, branch on the answer, raise a task, email the team, connect a person.
- **A shared inbox** where operators take over, with routing, transfer, notes, saved replies, AI-drafted suggestions, contacts, tasks, satisfaction ratings and analytics.

It is multi-tenant software as a service. Each customer of ours (a "company" or tenant) gets a widget key, its own operators, knowledge, workflows and settings; plans meter what they use and Stripe moves them onto a paid plan. Email is a second inbound channel into the same inbox. A tenant can also expose its own catalogue and appointment diary to the bot through a small connector SDK it hosts, call any HTTP API from a workflow, receive signed webhooks, and pull its data through a read-only API.

**Who uses it**

| Person | Where | What they do |
|---|---|---|
| Visitor | The tenant's website, in the widget | Asks questions, taps buttons and cards, uploads a file, asks for a person, rates the chat. Anonymous by default; can give a name and email, or be vouched for by the tenant with a signed id. |
| Operator | `/admin` dashboard | Handles chats and email threads, uses saved replies and AI suggestions, tags, notes, transfers, tasks, contacts, analytics. |
| Company admin | Same dashboard plus settings | Everything an operator does, plus operators, widget, assistant persona and scope, knowledge base, workflows, webhooks, API keys, connector, business hours, routing, retention, email channel, billing view, audit log. |
| Platform superadmin | Same dashboard, extra sections | Creates companies and their admins, changes plans and limits, sees usage across tenants, runs and restores backups, reads platform-level audit entries. |

**Who it is for.** Small and mid-sized businesses that want one product for "answer the common questions automatically, follow our rules for the rest, and let a person step in". The eight built-in workflow templates say which trades were in mind: retail (order status, returns), clinics and salons (booking), SaaS (verified account lookup, cancellation), services (lead qualification), and any business (front-desk triage, complaints).

## 2. What it does today

The full inventory is in [FUNCTIONALITY_MAP.md](FUNCTIONALITY_MAP.md). This is the map at one level up.

### Widget
One script tag. Configured per tenant from the dashboard and overridable with `data-*` attributes. Renders inside a Shadow DOM so it neither breaks nor is broken by the host page. Greeting, business-hours notice, optional pre-chat form with a privacy link, quick-reply buttons, product and time-slot cards, file upload, "talk to a person", typing and read indicators, satisfaction prompt, session that survives reloads and reconnects, signed visitor identity. Content-hashed assets cached for a year behind a stable loader.

### AI assistant
OpenAI models (`gpt-4o` for replies, `gpt-4o-mini` for classification, `text-embedding-3-small` for retrieval). One reply path for both the socket and the REST fallback: a published workflow answers if the tenant has one, otherwise the assistant. The assistant checks scope, matches canned replies by meaning, retrieves the top five knowledge chunks, and answers in the tenant's persona with a word cap chosen from the question type. Visitor text never enters the system prompt; retrieved material is fenced and labelled as data. When an operator holds the chat, the same machinery drafts a suggestion for them instead.

### Knowledge
Import a web page, a PDF by URL, or pasted text. Chunked, embedded and stored in MongoDB with in-process ranking by default; Qdrant or Atlas vector search when configured. Re-import replaces a source atomically; a test box shows what the bot would retrieve. Google Sheets can be imported through the user's own Google account, but those rows are stored in a separate collection the assistant does not read (see section 5).

### Workflow engine and editor
Twenty node types: persona, moderation, start, knowledge, AI reply, fixed reply, router (intent, keyword, contains, regex), fallback, human handoff, call an API, ask a question, offer choices, check a value, set a value, open or closed, add a tag, create a task, email the team, use your data. Multi-turn: a workflow can ask, wait, validate the answer and resume where it left off. Compile-time validation with cycle rejection, a 50-step cap per turn, and immutable safety and persona prompts. Preview runs the graph as a real conversation on the canvas without side effects. Versions with rollback; publishing hot-swaps into the live runtime. Eight complete templates. Five action presets fill in Shopify, Stripe, Zendesk, Slack and HubSpot request shapes.

### A tenant's own data and systems
- **Call an API** from a workflow with encrypted credentials, output mapping, and outbound safety checks (no private addresses, redirect re-validation, size and time caps).
- **Connector SDK**: an npm package the tenant hosts at one URL, implementing `catalog.search`, `catalog.get`, `availability.slots`, `availability.book`. Requests are HMAC-signed with a five-minute window; results are validated into fixed shapes the widget renders as cards and buttons. Reads are cached; writes never run in preview.
- **Identity**: the tenant signs a visitor id with HMAC; only a verified visitor unlocks account-specific workflow paths.
- **Outbound webhooks** for eight events, signed, retried, with a delivery log.
- **Public read API** with scoped, hashed keys and cursor paging.

### Operator inbox
Live queue with All / Mine / Unassigned, auto-assignment by load with capacity per operator, atomic claim, forced takeover for admins, transfer with a note, internal notes, saved replies, AI suggestions, multi-chat, tags, business hours per timezone, self-service availability, satisfaction ratings attributed to bot or operator, contacts with three identity levels, tasks with comments and activity, deadline notifications. Operator disconnect releases their chats after a grace period.

### Analytics
Volume, response time, traffic sources, satisfaction on every plan. Advanced plans add deflection, abandonment, staffing heatmap, per-operator workload with median response time, recurring topics and task throughput.

### Plans and billing
Trial (14 days), Basic $29, Professional $99, Enterprise negotiated. Meters: conversations, AI replies, seats, workflows, knowledge chunks, API requests per minute. Enforced on the chat path, on creation routes and per API request, with 402 responses that name the meter and plan. Stripe webhooks with signature verification and idempotency move tenants between plans; there is no in-product checkout yet.

### Security and compliance
Tenant scoping that fails closed, visitor session tokens, JWTs that die on password change or logout, rate limits shared across instances, secrets encrypted at rest, append-only audit log, GDPR export and erasure that cover conversations, contacts, files, tasks and webhook payloads, per-tenant retention with anonymise-then-delete, per-tenant backups with restore, content security policy without inline scripts.

### Operations
Docker image, compose file, CI, health and readiness probes, Prometheus metrics behind a token, JSON logs with query-string redaction, graceful shutdown, optional Redis adapter for multiple instances, scheduler flag so background jobs run on exactly one instance.

## 3. The market

Full detail and sources: [research/market-landscape-2026-09.md](research/market-landscape-2026-09.md).

### Who succeeds, and how

| Product | Target | How it works | Pricing model (2026) | What made it win |
|---|---|---|---|---|
| Intercom Fin | SaaS, SMB to enterprise; sold standalone into other helpdesks | Help-centre-first RAG, Procedures, Copilot; chat, email, in-app, WhatsApp, voice | Seats $29 to $132 plus $0.99 per outcome | Invented per-resolution pricing; best messenger; decoupled the AI agent from the inbox |
| Zendesk | Mid-market and enterprise | Ticketing suite with AI agents on every plan, Agent Builder, MCP | Seats $19 to $115 plus included resolutions, then about $1.50 to $2.00 per verified resolution | Incumbent ticketing, largest marketplace, bought Forethought, bills only verified resolutions |
| Tidio / Lyro | SMB and e-commerce | Widget plus inbox, Lyro answers and runs Shopify tasks, Flows for proactive messages | Free tier; $29 to $300; Lyro metered separately | Freemium, Shopify and WordPress app-store distribution, five-minute setup |
| Crisp | EU SMB | All-in-one inbox, ten channels, Hugo AI, tenant-hosted MCP tools | Flat per workspace: free, $45, $95, $295 | Predictable pricing, EU-only hosting, real free tier |
| HubSpot Breeze | HubSpot customers | Answers from knowledge and CRM record, Audit Cards | 50 credits (about $0.50) per resolved conversation | Zero-integration CRM context, cheapest big-vendor resolution |
| Chatbase | SMB and agencies | Train on URLs, files, text; Actions; many channels | Credits: $40 to $500 per month | Ten-minute product-led setup, model choice, agency resale |
| Gorgias | E-commerce | Shopify-native helpdesk with order actions | Per ticket, AI at $0.90 to $1.00 per resolution | Vertical depth; used by a large share of Shopify brands |
| Ada, Sierra, Decagon | Enterprise | Agent platforms with natural-language procedures, SDKs, guardrails, simulations | Per conversation or per resolution; six-figure contracts | Outcome pricing with guarantees; deep integration work |
| Voiceflow, Botpress | Agencies and developers | Visual canvas or code, knowledge base, tool calling | Credits; Botpress passes AI cost through | Best builders; no inbox of their own |
| Drift | B2B marketing | Web chat playbooks | From $2,500 a month | Being sunset in 2026 after an acquisition and a breach: the warning case for a narrow chat widget with leaky integrations |

**Pricing anchors.** Per-resolution clusters at $0.50 (HubSpot), $0.99 (Intercom, ChatBot.com, Gorgias) and $1.50 to $2.00 (Zendesk, Sierra). The loudest complaints are stacked meters, double billing and hard stops. Every vendor's headline resolution rate lands far above independent measurements (Intercom claims 76%, tests find 38% to 53%), and reviewers blame knowledge quality, not the model.

### The feature baseline every successful product has

| Baseline | Where we stand |
|---|---|
| Knowledge from many sources: crawl a site, import a help centre, upload files, commerce data; cite sources | Partial. URL, PDF by URL and pasted text only. No file upload, no CSV, no help-centre connectors, no citations. Sheets are imported but unread. |
| AI agent with an explicit resolution definition, confidence fallback, handoff, resolution reporting | Partial. Handoff and deflection metric exist. No "verified resolution" concept, which is what the market now bills on. |
| Actions the agent decides to use: order status, refunds, booking, custom REST | Partial. Actions exist but only a workflow author can invoke them. The model never chooses a tool itself. |
| Omnichannel inbox: web, email, WhatsApp, Messenger, Instagram | Missing beyond web and email. |
| Operator mobile apps | Missing. |
| Proactive messages and campaigns with triggers | Missing. |
| Agent copilot: suggestions, summaries, translation | Partial. Suggestions only. |
| Multilingual by default | Partial. The model answers in any language; the widget and dashboard are English only. |
| Integrations marketplace, Zapier, API and webhooks | Partial. Webhooks, presets and a read API exist. No Zapier, no marketplace. |
| Platform plugins: Shopify app, WordPress plugin | Missing. This is how Tidio reached 300,000 businesses. |
| SOC 2, GDPR, EU hosting option | Partial. GDPR tooling is real. No SOC 2, single region. |
| Analytics and CSAT | Have. |
| Team management: roles, routing, SLAs, macros | Partial. Routing and saved replies exist. No SLAs, skills or departments. |
| Free tier or no-card trial | Partial. Fourteen-day trial, no free tier. |
| Guardrails and observability: off-topic guard, QA scoring, spend caps | Partial. Scope guard, moderation node and quotas exist. No QA scoring or resolution audit. |

### Distribution
The winners are distributed through app stores and plugins, not search ads: Shopify and WordPress listings for Tidio and Gorgias, helpdesk marketplaces for the AI-only vendors, open source as a funnel for Chatwoot and Botpress. Templates, a free tier with a lifetime AI allowance, and guarantees (Intercom's 65% floor, Tidio's 50%) are the other recurring moves.

## 4. How the market connects to customers' data

Full detail and sources: [research/customer-data-connection-2026-09.md](research/customer-data-connection-2026-09.md).

### The dominant pattern in 2026
Every support vendor converged on the same shape. None of them imports OpenAPI; that stayed with GPT Actions and Salesforce.

1. **A form-defined action.** Name, a natural-language "when to use this" that drives selection, typed inputs (collected from the visitor, taken from a verified attribute, or constant), URL, method, headers and body with variable insertion, and a credential kept in a vault.
2. **A test panel** that runs the call or accepts sample JSON, so the action can be built before the API exists.
3. **Two ways to read the response**: hand the raw JSON to the model with a size cap (Intercom, Chatbase), or map paths into variables (Zendesk with JSONata, Ada with JMESPath, Gorgias with JSONPath).
4. **Invocation by tool calling, with a switch.** "Direct trigger", where the model calls it when a question matches, versus "only inside a procedure or flow". Intercom, Ada, Chatbase, Gorgias and Voiceflow all expose exactly this switch.
5. **Guardrails**: audience rules, a per-action "requires verified customer" gate, customer confirmation before writes, idempotency guidance, 15 to 30 second timeouts, one call per turn, an audit trail.
6. **Natural-language procedures on top** (Intercom Procedures, Zendesk generative procedures, Ada Playbooks, Decagon operating procedures) with simulation testing.
7. **MCP as the second on-ramp.** Register a remote server and a credential, auto-discover its tools, enable them one by one. Intercom, Zendesk, Ada, Crisp and Voiceflow consume a tenant's own MCP server today; Shopify, Stripe, HubSpot, Zapier and Notion publish servers.

### How they know who they are talking to
- HMAC user hashes are being retired in favour of short-lived JWTs that can carry signed attributes (Intercom and Chatbase both deprecated the hash). Crisp and Front still use HMAC.
- Verification gates actions and data, not the whole bot: Intercom's per-connector "customer authentication", Crisp's per-tool OTP, HubSpot's match or verify email, Zendesk's branch on authenticated user.
- The anonymous fallback everywhere is an in-chat email or SMS one-time code (Intercom: six digits, ten minutes, three attempts). E-commerce adds order number plus postcode.
- Enterprise adds OAuth inside the chat with per-user tokens forwarded to tools (Ada, Shopify Customer Accounts MCP).
- Unsigned attributes are treated as untrusted.

### Where we stand
Our connector SDK is, almost feature for feature, what Crisp shipped as the "Hugo MCP API": a tenant-hosted server, HMAC-plus-timestamp signing, fixed result shapes, per-tool identity gates. The difference is that Crisp used MCP as the wire protocol, so any existing MCP server (Shopify, Stripe) plugs in. Our "Call an API" node is the flow-only pattern Zendesk and Tidio now label legacy. Our HMAC identity is the pattern Intercom and Chatbase have deprecated.

## 5. Recommendations

Ranked by value. Each reuses what already exists.

**1. Actions the model can choose, defined once, usable from workflows too.** Turn the action node's configuration into a first-class "Action" object: name, when-to-use text, typed inputs, request, credential, test panel, raw-JSON-to-model with a cap plus optional path extraction, a "direct trigger or workflow only" switch, a "requires verified visitor" gate, confirmation before non-GET, one call per turn, audit entries. Hand enabled actions and the connector capabilities to the model as tools. Convert the five presets into action templates. This is the single largest gap against every product in the table and the todo.md item "let the assistant choose a capability itself".

**2. Identity that expires, with a fallback.** Accept a signed JWT (`user_id`, `exp`, signed attributes) alongside the HMAC hash. Add an in-chat email one-time code so an anonymous visitor can become verified without the tenant writing code. Expose verified state and signed attributes as action inputs, and let a knowledge source or action require them.

**3. Make the connector MCP-compatible and add an MCP client.** Keep the SDK's value (typed helpers, signing, card hints) but speak MCP on the wire, and let a tenant register any MCP server with per-tool enablement and the same verified gate. Ship templates for Shopify Storefront and Customer Accounts, Stripe and Zapier. Step 3 reuses step 1's runtime.

**Google Sheets: do both of these, in this order.**
- Now: index every stored row as one knowledge chunk serialised as `Header: value` pairs, with the sheet id and each column as chunk metadata, and refresh on a schedule. This is exactly how Voiceflow treats CSV and XLSX, and how Crisp, Chatbase, Zendesk, HubSpot and Tidio treat tabular sources. It needs a "use in answers" toggle and no new UI beyond that, and it turns the current dead end into the most common use of a spreadsheet: FAQ, pricing, store list, policy tables.
- After actions exist: expose a sheet as a built-in lookup action ("find rows in sheet X where key column equals value"), with the tenant naming the key and searchable columns, so the model answers exact-match questions vector search gets wrong and can return rows as cards. If the key column identifies a customer, restrict lookups to the verified visitor's own key. This mirrors Botpress Tables and Voiceflow's Sheets tool.
- Skip write-back to sheets; no customer-facing agent in the market does it.

**Then, in order of distribution value:** a WordPress plugin and a Shopify app (they double as onboarding: crawl the site, import the catalogue); WhatsApp and Messenger into the inbox; a "verified resolution" definition with reporting, so pricing can move to one meter with a cap; operator mobile apps or at least a responsive inbox; SOC 2 and an EU region.

## 6. Known gaps and defects

Owner-acknowledged items live in [todo.md](../todo.md). Additional items found while mapping the code on 2026-09-09, in rough order of customer impact (details in [FUNCTIONALITY_MAP.md](FUNCTIONALITY_MAP.md) section 6):

- Saving a canned reply from the Assistant section calls the wrong path (`admin-assistant.js` builds `/<id>` instead of `/api/templates/<id>`), so create and edit cannot succeed from the UI.
- The workflow knowledge node still offers `google_sheets` as a source type, but the loader uses the google-spreadsheet v3 API against the installed v4 and is likely broken at runtime.
- `conversation.started` is in the webhook catalogue but never fires; `conversation.ended` fires only for operator-ended chats; `task.created` fires only from the workflow node.
- Response-template roles `fallback` and `handoff` are stored but never used by the assistant.
- `Company.identitySecret`, the inbound email secret and Google OAuth tokens are not encrypted at rest (only hidden from default queries).
- Inbound email trusts the shared secret only; provider signatures are not verified.
- Deleting a company removes only the company document; a purge helper exists but has no caller.
- Company create, update and delete, operator creation, admin password resets and whole-database backups write no audit entries.
- Settings tabs are not role-gated in the dashboard, so operators see errors on admin-only tabs; superadmins see empty retention and API-key panes.
- Operators cannot send attachments, and the operator transcript never renders a visitor's file link.
- Workflow execution stats are never persisted, so the stats endpoint always returns zeros.
- No Zapier, no in-product checkout, no operator invite by email, no widget JavaScript API beyond `init`, no translations.
