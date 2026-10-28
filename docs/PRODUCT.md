# Product overview

_Written 2026-09-09 from the working tree on `production-readiness`; the baseline table and section 6 were updated on 2026-10-05 after the dashboard restructure, on 2026-10-22 after the launch-review pass, and again on 2026-10-22 after Phase 2 (booking, WhatsApp/Messenger/Instagram, the operator app with push, JWT identity and email codes, the WordPress plugin and Shopify snippet, MCP, agencies, per-resolution pricing), along with section 4's "Where we stand" and a status note in section 5. Sections 1 and 2 still describe the product as of 2026-09-09; [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) says what changed since. Companion documents: [FUNCTIONALITY_MAP.md](FUNCTIONALITY_MAP.md) (every endpoint, socket event, model and setting, read from the code), [research/market-landscape-2026-09.md](research/market-landscape-2026-09.md) (sixteen competing products, with sources) and [research/customer-data-connection-2026-09.md](research/customer-data-connection-2026-09.md) (how those products let an AI agent reach a customer's own systems, with sources)._

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

> **The Intercom row is out of date.** Web sources gathered on 2026-10-21 report that Intercom renamed itself Fin and was acquired by Salesforce in September 2026, after the research in [research/market-landscape-2026-09.md](research/market-landscape-2026-09.md) was written. That file has not been rewritten; read its Intercom entry, and the figures quoted from it here, as of September 2026.

**Pricing anchors.** Per-resolution clusters at $0.50 (HubSpot), $0.99 (Intercom, ChatBot.com, Gorgias) and $1.50 to $2.00 (Zendesk, Sierra). The loudest complaints are stacked meters, double billing and hard stops. Every vendor's headline resolution rate lands far above independent measurements (Intercom claims 76%, tests find 38% to 53%), and reviewers blame knowledge quality, not the model.

### The feature baseline every successful product has

| Baseline | Where we stand |
|---|---|
| Knowledge from many sources: crawl a site, import a help centre, upload files, commerce data; cite sources | Mostly. Site crawl in the background with progress, a weekly re-read per site or page that drops vanished pages, file upload (PDF, text, Markdown, CSV, HTML), single page or PDF by URL, editable pasted text, citations in replies, and how many answers each source fed. Sign-up reads the customer's website straight away. No help-centre connectors; Sheets are imported but unread, and their card is hidden by default. |
| AI agent with an explicit resolution definition, confidence fallback, handoff, resolution reporting | Have (2026-10). The value report counts "resolved by the bot" by a published, strict definition (visitor wrote, bot answered, nobody joined or was asked for, last answer not an "I don't know", not rated 1 or 2), with hours saved and cost per resolution. The assistant flags what it could not answer, and a failure, a spent allowance or an unanswerable question hands over or takes a message rather than ending in an apology. Since Phase 2 Professional can be paid per resolution on exactly that definition, counted only once a conversation has ended or sat idle a day, with a spending cap the tenant sets and past which the bot keeps answering; reported daily to a Stripe Billing Meter. Prices are placeholders, and the meter has not been tried against Stripe. |
| Actions the agent decides to use: order status, refunds, booking, custom REST | Have (2026-10). Saved Actions (Bot → Actions, with Run once and a run log), connector capabilities and, since Phase 2, tools from any remote MCP server the tenant connects (switched on one by one: automatic or workflow only, verified customers only, ask before running) are offered to the assistant as tools, with a verified gate, confirmation before writes and per-turn caps; workflows can reference the same Actions. Native booking in Cal.com, Google Calendar or Calendly (on Calendly's free plan, a pre-filled link to finish). Workflows cannot call MCP tools yet, OAuth MCP servers cannot be connected, and no MCP server or calendar has been tried for real. |
| Omnichannel inbox: web, email, WhatsApp, Messenger, Instagram | Have, untried against Meta (2026-10). WhatsApp Cloud API, Messenger and Instagram Direct arrive in the same inbox through the tenant's own Meta app, answered by the same bot and handed over the same way, with the 24-hour reply window shown and enforced (an approved WhatsApp template after it; the Human Agent tag to seven days where Meta approved it). Not yet: sending files to app customers, typing indicators, notices there in other languages. Plan feature on trial, Professional, Agency and Enterprise. |
| Operator mobile apps | Mostly (2026-10). The dashboard installs as an app on Android, iPhone and iPad (iOS 16.4+) and desktop, and Web Push reaches a closed app: new chats and hand-overs, assignments, transfers, long waits, low ratings, tasks, usage warnings, with previews off unless a person turns them on. No native store apps; push not yet tried on a real phone. |
| Proactive messages and campaigns with triggers | Partial (2026-10). One proactive message per tenant (delay, page filter, once per visit). No campaigns or audience rules. |
| Agent copilot: suggestions, summaries, translation | Partial. Suggestions on every plan (Basic gained them). A hand-over now carries what the visitor asked (their last three messages), not a model's summary. No translation. |
| Multilingual by default | Partial. The model answers in any language and the widget, including every notice, speaks eleven; the dashboard is English only. |
| Integrations marketplace, Zapier, API and webhooks | Partial. Webhooks (with redelivery, now including bookings), presets, a read API, a widget JavaScript API, and an MCP client, through which Zapier's, Stripe's, Shopify's or HubSpot's own MCP servers can be connected. No Zapier app of our own, no marketplace. |
| Platform plugins: Shopify app, WordPress plugin | Partial (2026-10). A WordPress plugin (settings page, hide-on paths, logged-in users signed in on the server) and a Shopify theme snippet (logged-in customers through an App Proxy token or a metafield hash), each downloadable pre-filled from the dashboard. Neither is listed in its store, and that listing is the distribution that made Tidio reach 300,000 businesses. |
| SOC 2, GDPR, EU hosting option | Partial. GDPR tooling is real and now has a screen (export and erase from People), plus a consent checkbox in the widget and an AI disclosure. No SOC 2, single region. |
| Analytics and CSAT | Have. Satisfaction is split bot against people, low ratings notify, and every ended chat can carry an outcome. |
| Team management: roles, routing, SLAs, macros | Partial. Invitations, routing, transfer with presence, saved replies with placeholders, outcomes, an alert to the team when someone has waited too long for a person, and agencies running several client companies. No SLAs, skills or departments. |
| Free tier or no-card trial | Partial. Self-serve sign-up starts a fourteen-day trial with no card. No free tier. |
| Guardrails and observability: off-topic guard, QA scoring, spend caps | Partial. Scope guard, moderation node, quotas with warnings at 80% and 100%, a monthly spending cap on resolutions, an unanswered-questions list, visitor thumbs, and saved tests that re-run after every change taught. No QA scoring or resolution audit. |

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
Our connector SDK is, almost feature for feature, what Crisp shipped as the "Hugo MCP API": a tenant-hosted server, HMAC-plus-timestamp signing, fixed result shapes, per-tool identity gates. The difference is that Crisp used MCP as the wire protocol, so any existing MCP server (Shopify, Stripe) plugs in. Our "Call an API" node is the flow-only pattern Zendesk and Tidio now label legacy.

Since Phase 2 (2026-10-22) the other two gaps this section named are closed in code. Saved Actions are the form-defined, model-chosen actions of steps 1 to 5, and an MCP client is the second on-ramp of step 7: register a remote server, discover its tools, enable them one by one with the verified gate. Identity follows the market: a short-lived signed JWT with signed attributes is recommended and the HMAC still accepted, and an anonymous visitor can verify with an in-chat email code (six digits, ten minutes, three attempts, as Intercom does) that unlocks only the actions a tenant marks as safe for it. What is still behind: signed attributes are shown but cannot yet feed an action's inputs, MCP tools cannot be called from workflows, OAuth-protected MCP servers and OAuth inside the chat are not supported, and none of it has met a real server yet.

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

> **Status, 2026-10-22.** Recommendations 1, 2 and 3 are built (saved Actions; JWT identity and in-chat email codes; an MCP client, though the connector itself still speaks its own protocol rather than MCP). Of the "then" list, the WordPress plugin and a Shopify theme snippet exist without store listings or catalogue import, WhatsApp, Messenger and Instagram are in the inbox, per-resolution pricing with a cap is built, and the operator app is an installable PWA with push. SOC 2 and an EU region are not started. The Google Sheets recommendation is still undecided. None of the Phase 2 integrations has yet been tried against the real service.

## 6. Known gaps and defects

Owner-acknowledged items, including everything the October launch review put in "the next ninety days" and "later" that is still open, live in [todo.md](../todo.md). Additional items found while mapping the code, still open on 2026-10-22 after Phase 2, in rough order of customer impact (details in [FUNCTIONALITY_MAP.md](FUNCTIONALITY_MAP.md) section 6):

- None of Phase 2's integrations has been tried against the real service: Meta, Cal.com, Google Calendar, Calendly, Stripe's Billing Meter, MCP servers, push on a real phone, a WordPress or Shopify install. Each first real setup is its test ([INTEGRATIONS_SETUP.md](INTEGRATIONS_SETUP.md) has the steps).
- An operator reply sent in the seconds before the server notices a visitor left goes to the chat, not by email.
- Messaging apps: operators cannot send files to app customers, no typing indicator is sent, the notices sent there are English only, and two messages from one customer arriving at once on different instances are answered side by side rather than in turn.
- An agency's clients beyond the included ones are counted but not billed.
- Per-tenant backups carry every stored credential (encrypted where the database has it encrypted) and token hash, as a database dump does, so the backup directory needs the same protection as the database.
- A JWT's signed attributes are shown but cannot feed action inputs; MCP tools set to "workflow only" are unused because workflows cannot call them; the REST fallback accepts HMAC identity but not a JWT.
- Every workflow Knowledge step searches the tenant's knowledge base whatever its source type says. New nodes no longer offer `google_sheets`, `pdf` or `url`; old nodes keep the setting, labelled as an older one.
- `Company.identitySecret`, the inbound email secret and Google OAuth tokens for the Sheets import are not encrypted at rest (only hidden from default queries). Integration credentials added in Phase 2 are encrypted.
- Inbound email trusts the shared secret only; provider signatures are not verified.
- Whole-database backups write no audit entries.
- Write confirmation for Actions and MCP tools recognises English affirmatives only; booking reminders are English only.
- No Zapier app of our own, and the dashboard is English only (the widget speaks eleven languages).

Fixed on 2026-10-05 with the dashboard restructure: the canned-reply save path, role gating (each screen is hidden from roles that cannot use it, and a superadmin has a Platform area instead of tenant screens), operator attachments in both directions, in-product checkout, and the editor's saved-action picker.

Fixed on 2026-10-22 with the launch-review pass: `conversation.started` fires (on a visitor's first action, and for email) and `task.created` fires for tasks operators create; the `fallback` and `handoff` canned-reply roles are used; company create, update and delete, operator creation and removal, and admin password resets are audited; workflow run statistics are persisted; operators are invited by email; the widget has a JavaScript API. Also: page views no longer create conversations, a model failure or a spent allowance hands over instead of apologising, a tenant's widget runs only on that tenant's own domains, and seats count operators only.

Fixed on 2026-10-22 with Phase 2: a hand-over carries what the visitor asked; long waits alert the team (`visitor_waiting` notifications); idle web chats end, so `conversation.ended` fires for conversations the bot handled alone; deleting a company deletes its data and files; the setup checklist's persona step follows the persona the assistant actually uses; task assignment is company-scoped in the service; forcing a colleague's chat closed needs an explicit confirmation the server checks; a new admin clicking quickly is no longer rate limited.
