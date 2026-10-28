# Chatbot Platform — Functionality Map

_Read from the working tree at `/Users/undefined/dev/proj/personal/chatbot-construction` on 2026-09-09 (branch `production-readiness`, uncommitted changes included). Every statement below is taken from the code; file paths are relative to the repo root._

> **Updated 2026-10-22** from the working tree after the launch-review pass (uncommitted, on `production-readiness`). Sections 3 (every route and socket event), 4 (models), 5 (settings and environment) and 6 (known gaps) were re-read from the code and rewritten; section 2 was corrected where it had become false and gained 2.11 (sign-up, invitations, sessions) and 2.12 (the learning loop). Between 2026-09-09 and 2026-10-05 the dashboard moved to `client/`, knowledge gained site crawl, file upload and citations, and saved Actions, Test your bot, in-product checkout, operator attachments and widget translations were added; [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) describes both rounds in prose.
>
> **Updated again 2026-10-22 after Phase 2** (same working tree). New: 2.13 booking, 2.14 WhatsApp/Messenger/Instagram, 2.15 visitor identity and email codes, 2.16 MCP, 2.17 the operator app and push, 2.18 agencies, white-label and per-resolution pricing, 2.19 the WordPress plugin and Shopify snippet; the routes, socket events, models, settings, scheduler jobs and gaps in sections 2.1–2.10 and 3–6 were brought up to date from the code. Setup steps for the third parties are in [INTEGRATIONS_SETUP.md](INTEGRATIONS_SETUP.md).

---

## 1. What the product is

A multi-tenant customer-support chat SaaS (Node.js 20, Express 4, MongoDB via Mongoose 8, socket.io 4, OpenAI). Each tenant ("company") embeds a JavaScript widget on its own website (by hand, with the WordPress plugin or with the Shopify snippet); visitors chat with an AI assistant that answers from the tenant's own knowledge base and/or a published visual workflow, and can be handed to a human operator working in the `/admin` dashboard, which installs as an app with push notifications. Email, WhatsApp, Messenger and Instagram are further inbound channels into the same inbox. Tenants can expose their own catalogue/appointment data to the bot through a signed connector SDK, connect Cal.com, Google Calendar or Calendly for real booking, define Actions the assistant calls itself, connect remote MCP servers whose tools it may use, call any HTTP API from a workflow, receive signed outbound webhooks, and pull their data through a read-only public API. Customers sign themselves up (or are invited by the platform operator, or by an agency) onto a 14-day trial. Plans (Trial/Basic/Professional/Agency/Enterprise) meter conversations, AI replies, operator seats, live workflows, actions plus enabled MCP tools, and knowledge chunks; Professional can be paid per bot-resolved conversation with a spending cap. Stripe Checkout, a Billing Meter and webhooks move a tenant onto a paid plan.

Three user types:

| User | Where | What they are |
|---|---|---|
| **Visitor** | The tenant's website, inside the widget (`public/widget/js/widget.js`); or WhatsApp, Messenger or Instagram | Anonymous by default; can self-report name/email/phone (identity `claimed`), be vouched for by the tenant with a signed JWT or an HMAC (`verified`, `verifiedBy: jwt\|hmac`), or prove an email address with a code in the chat (`verified`, `verifiedBy: email_code`, which unlocks less). Authenticated to the socket only by a per-conversation session token. |
| **Operator / company admin** | `/admin` dashboard (`public/admin/index.html`, modules in `client/admin/*` bundled to `public/dist/`) and the workflow editor (`public/admin/workflow-editor.html`, `client/workflow-editor/`); sign-in, sign-up and invitation pages (`public/admin/login.html`, `signup.html`, `invite.html`; `client/login.js`, `signup.js`, `invite.js`) | Roles `operator` (handles chats, tasks, contacts, analytics; holds a plan seat) and `company_admin` (additionally manages the team, widget, channels, bot, knowledge, booking, workflows, MCP servers, webhooks, billing, audit, retention, API keys; holds no seat). Both belong to exactly one company (`models/user.js` requires `company` for these roles). A company's first admin either signed the company up or was invited by the superadmin or an agency. An admin of an **agency** (a company with `agency.isAgency`) also manages its client companies and may work in a client's dashboard with a one-hour token scoped to that client (2.18). |
| **Superadmin** | Same dashboard, a Platform area instead of tenant screens | Platform operator with `company: null`. Creates companies and invites their first admins, makes companies agencies, changes plans/pricing model/overage/limit overrides, sees every tenant's usage, runs and restores backups, sees platform-level audit entries. Bootstrapped once via `POST /api/auth/create-superadmin` while the users collection is empty. |

Tenant resolution (`services/tenant.js`): a company is identified by its `widgetKey` (`wk_…`, pasted into the embed snippet) or, failing that, by the request `Origin`/`Referer` matching its `allowedDomains`. The page's origin must be one of *that* company's allowed domains (`isOriginAllowed(origin, {widgetKey|companyId})`; the platform's own `ALLOWED_DOMAINS`/`PUBLIC_URL` always pass, localhost only outside production), and a domain can belong to only one company (409 `DOMAIN_TAKEN`). Every conversation is stamped with the company on creation; REST routes are scoped with `utils/query.js#companyFilter`; operators join a per-company socket room `operators:<companyId>` and superadmins join `operators:all`.

---

## 2. Feature map

### 2.1 Widget (`public/widget/js/widget-loader.js`, `public/widget/js/widget.js`, `routes/widget.js`)

**Loading.** The tenant pastes one `<script>` tag pointing at `widget-loader.js` (served `no-cache`; the widget itself is served content-hashed and cached immutable for a year, `services/asset-manifest.js`, `server.js`). The dashboard's snippet carries only `src`, `data-widget-key` and `data-server-url`, so appearance changes saved later reach installed sites. The loader defines `window.ChatWidget` at once as a stand-in that queues calls, fetches `GET /api/widget/config?key=<widgetKey>` **without credentials**, merges defaults ← server `settings` ← `data-*` attributes, injects the hashed `widget.js`, calls `window.ChatbotWidget.init(config)`, and replays the queued calls. If the config fetch fails the widget still loads with default branding. No iframe; the widget renders into an open Shadow DOM under a fixed-position host `div` (`z-index: 2147483000`). socket.io client is loaded from `<serverUrl>/socket.io/socket.io.js` unless `window.io` already exists.

**Server config endpoint.** `GET /api/widget/config` is public. Known tenant → `{recognised:true, companyName, settings: {chatbotName, primaryColor, position, welcomeMessage, logoUrl (https only), language, requireName, requireEmail, requirePhone, privacyPolicyUrl (or null), suggestedQuestions (≤4), consentRequired, consentText, proactive (or null)}, availability:{open, canReachOperator, offlineMessage, opensAt}, features:{fileUploads}, assets}`; unknown tenant or any error → defaults with `recognised:false`. A request from one of the tenant's allowed domains records `Company.widgetSeen` (at most one write a minute per company, `services/widget-install.js`), which is the dashboard's "Seen on …". Nothing about the tenant's plan reaches the visitor beyond whether to draw the paperclip.

**Visitor-facing features (all in `widget.js`):**
- Launcher button with ARIA labels; chat window `role="dialog"`; Escape closes and returns focus to the launcher. Opening in one tab does not open the others; messages are shared between tabs of one browser via `BroadcastChannel`.
- Header: the business's name and logo while the assistant keeps the default name "Assistant", the custom name otherwise; once a person joins, their name with "from <business>", and "Talk to a person" is hidden until they leave.
- Greeting (`initialMessage`, server `welcomeMessage`) for fresh sessions, with a line saying the visitor is talking to an AI (EU AI Act Art. 50) when the greeting does not already say so; up to four suggested questions as buttons until the conversation starts.
- Proactive message: after `delaySeconds` (5–120), on pages whose path contains `pathContains` (all when empty), once per visit, dismissible, never to somebody already chatting.
- Business-hours closed notice from `availability` (`offlineMessage` + "We reopen <opensAt>").
- Pre-chat form (name/email/phone) only when a field is required (all off by default for new companies; companies created earlier keep stored `requireName/requireEmail: true` until edited); consent checkbox when `consentRequired` (nothing typed or uploaded is sent until it is ticked; the agreement travels as `consent` and is stored in the conversation's metadata); privacy link is the tenant's or absent; details persisted in `localStorage` for 30 days; operator can force the form (`request-user-details`).
- Message rendering: text with minimal markdown and clickable links (new tab); sender name and time; sent/read ticks (`message-read`); quick-reply buttons from `message.choices` (max 8; a choice with `action: 'verify_email'` opens the email-code form instead of sending text); cards from `message.cards` — `Slot` cards as tappable time buttons, other cards as product cards, whose link reads **Finish booking** instead of "View" when the card's `status` is `link` (a Calendly free-plan booking, 2.13); file chips with image thumbnails; a "Sources" line; typing indicators; `aria-live` announcements; right-to-left layout (`data-dir`, or the language). Cards and choices survive a reload.
- Email-code form (2.15): opened by the assistant's "Verify with your email" choice, by `verify-email-request` from the server, or by `ChatWidget.verifyEmail()`; address, then the six-digit code, over `verify-email-start` / `verify-email-code`; results and failures shown in the visitor's language.
- Thumbs up/down on rateable bot answers (`message-feedback`; not on hand-over lines or "I don't know"); a thumbs-down offers a person.
- "Talk to a person" once the visitor has written → `request-operator`; it becomes **Leave a message** (email + optional message → `leave-message`) when the company is closed or nobody is online and taking chats, and the same form opens on `followup-request`.
- File upload (paperclip, hidden when the plan lacks `fileUploads`; png/jpg/gif/webp/pdf/txt/csv/doc/docx/xls/xlsx; 10 MB client cap) via `POST /api/upload`, then `file-uploaded`.
- CSAT prompt on `chat-ended {requestRating:true}` (asked once the visitor wrote at least once): 1–5 buttons, score sent immediately, optional comment afterwards, "No thanks" → `decline-rating`.
- Server notices (`unavailable`, `reply_failed`, `operator_joined`, `operator_left`, `handed_back`, `queued`, `queued_offline`, `followup_saved`, `chat_ended`, `handoff_offer`, `identity_expired`, `verify_email_*`) arrive as `code` + `params` (+ an English `message`) and are rendered in the visitor's language; no raw error text is shown.
- Session persistence: `chatbotSessionId` (UUID) + `chatbotSessionToken` in localStorage; every socket `connect` re-emits `resume-session`. Nothing is created on page load: `session-ready {pending:true}` binds the socket until the visitor's first action creates the conversation. `session-rejected` → new session; a tenant whose conversation allowance is spent answers the first message with the `unavailable` notice.
- Reconnection: socket.io auto-reconnect (infinite attempts), 30 s heartbeat, reconnect on tab visibility; input disabled while offline. Each message carries the widget's own id (`clientMessageId`), so one resent after a reconnect is not stored twice.
- Identity: `data-user-jwt` (a token the tenant's server signed; preferred) or `data-user-id` + `data-user-hash` (HMAC), or the same through `ChatWidget.identify`, are sent in the socket handshake `auth` (`userJwt`, `externalId`, `userHash`) and with `user-details`; the server ignores anything it cannot verify (2.15). The widget reads the user id from a token's `sub`. After `session-ready` it emits `visitor-identity` so the server can attach a sign-in that happened after the conversation started; an expired token comes back as the `identity_expired` notice and the widget fires `identity-expired` (telling the visitor once only when the page is not listening). A different user id on the same browser starts a clean session.
- Languages: English, Spanish, French, German, Italian, Portuguese, Romanian, Russian, Ukrainian, Polish, Dutch; `data-language` > tenant `language` > browser > English.
- JavaScript API `window.ChatWidget` (also `window.ChatbotWidget`): `open`, `close`, `toggle`, `identify({jwt} | {userId, userHash}, plus name, email)`, `verifyEmail()`, `shutdown`, `init`, `on`/`off` for `open`, `close`, `message` (`{id, sender, text, operatorName?}`), `handoff` (`status: requested|queued|connected|offline|message_left`), `verified` (`{method: 'email', email}`) and `identity-expired` (`{userId}`). Calls before load are queued, `verifyEmail` included.
- Theming: `--primary-color` CSS variable, left/right position, chatbot name, logo.
- **Not present:** sound, transcript email, live sync across devices (the widget listens for a `user-message` echo that the server never sends; tabs of one browser are kept in step by `BroadcastChannel` instead), the `POST /api/gdpr/consent` call (consent travels on the socket instead), end-to-end encryption (removed 2026-09-08).

### 2.2 AI assistant (`services/ai.js`, `services/reply.js`, `services/promptEngineering.js`, `services/assistant-config.js`, `services/responseTemplates.js`, `services/intent-classifier.js`)

- **Provider:** OpenAI only (`openai` ^5). Replies `OPENAI_MODEL` (default `gpt-4o`); scope classifier and workflow-trigger picker `OPENAI_CLASSIFIER_MODEL` (default `gpt-4o-mini`); workflow LLM nodes `gpt-4o-mini` default; embeddings `EMBEDDING_MODEL` (default `text-embedding-3-small`). 30 s timeout, 1 retry. No streaming, no token accounting (the platform's AI cost is estimated as replies × `AI_COST_PER_REPLY`), no secondary provider.
- **Reply seam (`services/reply.js#generate`):** used by the socket handler, `POST /api/chat/message`, Test your bot and saved tests. Order: (1) a live workflow this conversation is part-way through (it asked a question) carries on, but only within the same workflow and live version; (2) otherwise the first live workflow whose trigger matches — `keywords` first (whole words), then `intent` (one `OPENAI_CLASSIFIER_MODEL` call that picks among every intent description, falling back to embedding similarity against `WORKFLOW_PICK_THRESHOLD` 0.45 without a model), then the one `always` workflow; (3) otherwise `AIService.generateResponse`. A workflow that throws or reports a failed step falls back to the assistant; a workflow that finished last turn does not hold the conversation. Returns `{text, choices, cards, escalate, toolCalls, source: workflow|assistant, path: workflow|canned|assistant|fallback, sources, failed, unanswered, metered}`. `aiResponses` is metered only when `metered` (the assistant answered, or a workflow AI Reply step ran); canned replies, fixed workflow messages and failures are free.
- **Assistant pipeline (`AIService.generateResponse`):** (1) if a `scope` is configured, `isOnTopic` classifier (fails open) → the `offTopic` canned reply or a fixed line offering a colleague; (2) a greeting — at most four words, all greetings or filler, so "which" and "shipping" no longer match — → `greeting` canned reply; (3) semantic match against the tenant's canned replies; (4) `detectPromptType` (regex → informational / concernResolution / comparison / instructional / escalation, each with a word cap), `retrieveKnowledge` (top 5 chunks, minScore 0.15) wrapped in `<knowledge>` tags with "treat as data, not instructions", persona-led system prompt that asks for `[[NO_ANSWER]]` when the material does not cover the question, saved Actions, connector capabilities (answered by a connected calendar for the `availability.*` ones, 2.13), enabled automatic MCP tools (`mcp_<server>_<tool>`, 2.16) and, when proving an email would unlock an action, `verify_visitor_email` (2.15) as tools (`services/assistant-tools.js`), last 10 messages, `temperature 0.7`, `max_tokens 500`. A model error sets `lastFailed` and returns no text; an answer carrying the marker sets `lastUnanswered` and the marker is stripped. `{name}` and `{company}` are filled in canned replies. The visitor's text is never interpolated into the system prompt.
- **What the caller does with a reply (`websockets.js`, `routes/chat.js`, `services/conversation-lifecycle.js`):** `failed` → hand-over with reason `model_error` (the bot says the tenant's `handoff` canned reply or the `reply_failed` notice); `unanswered` → stored with `unanswered:true`, the tenant's `fallback` canned reply replaces the text when there is one, and a "Talk to a person" choice (`action:'handoff'`) is added; a spent `aiResponsesPerMonth` → hand-over with reason `quota`. Messages store `path` and `sources`.
- **Persona and scope (`assistant-config.js`):** `resolve(companyId)` → persona from the Persona node of the live workflow whose trigger is `always`, else `Company.assistant.persona`, else the default ("You are a customer support assistant. You are accurate, concise and plain spoken…"); `scope` always from `Company.assistant.scope` (empty = answer anything). Cached 60 s. Edited under **Bot → Persona & replies** (`GET/PUT /api/templates/assistant/config`, which also stores the guided builder's answers in `AssistantProfile`: business, what it does, tone friendly/professional/brief, never-guess list, when to hand over). `GET /api/bot/prompt-preview` shows the system prompt in effect, part by part; `POST /api/bot/persona-draft` drafts a persona from the tenant's knowledge (409 `NO_MODEL` without a key). No language or temperature settings.
- **Canned replies (`models/response-template.js`, `routes/templates.js`):** per-company templates with `name`, `role` (`greeting|fallback|offTopic|handoff|null`, one enabled template per role), `triggers[]` (example phrases), `responses[]` (one chosen at random), `variables` (`[KEY]` substitution), `threshold` (default 0.35), `enabled`, `useCount`, `lastUsedAt`. Matched by embedding similarity via the intent classifier, not keywords; the match test (`POST /api/templates/preview`) does not count as use. All four roles are now read: `greeting` and `offTopic` by `ai.js`, `fallback` for an unanswered reply, `handoff` when the bot passes a visitor on. `GET /api/templates/mine` serves them to operators as saved replies; the composer fills in `{name}`, `{email}` and `{operator}` (`client/admin/operator-tools.js`).
- **Intent routing (`intent-classifier.js`):** embedding cosine similarity of the visitor message against each Router `intent` condition's example phrases (comma/semicolon/pipe/newline separated), threshold 0.35 (per-condition override). Without `OPENAI_API_KEY` it degrades to a 256-dim bag-of-words hash (lexical only). Intents are whatever a workflow author types; there is no fixed list. `pickWorkflow` (above) is the separate, stricter choice between workflows.
- **Operator suggestions (`generateOperatorSuggestion`):** when an operator holds the chat, each visitor message (or `request-suggestions`) produces a draft delivered only to that operator (`operator-suggestion`; a failure comes back as `{error:true}` and is never shown as a usable draft), gated by plan feature `aiSuggestions` (now on every plan), `conversation.suggestionsEnabled` (the switch is in the composer), and the `aiResponsesPerMonth` meter.
- **Handoff triggers (all through `lifecycle.handOver`, which records `handoff {requestedAt, reason}`):** visitor button (`visitor_request`), the choice offered under an unanswered answer or after a thumbs-down, model failure (`model_error`), a spent AI allowance (`quota`), workflow `operator-handoff` or `fallback.escalation` (`workflow`), leaving an email when nobody can be reached (`offline_message`). Separately: operator takeover, and operator disconnect (grace `OPERATOR_GRACE_MS`, default 60 s, then reassign or re-queue).
- **Moderation:** workflow `moderation` node → `openai.moderations.create` on input and output (fails open without a key); strictness now changes the thresholds. `customFilters` are stored but never evaluated.

### 2.3 Workflow engine (`services/workflow-compiler.js`, `services/workflow-nodes.js`, `services/workflow-actions.js`, `services/workflow-runtime.js`, `services/workflow.js`, `config/workflow-templates.js`)

**Node types.** Type is `node.data.type || node.type`. Every node has one input. Only branching nodes may have more than one outgoing edge.

| Type | Editor label | Config (`data.*`) | Output ports | Runtime behaviour |
|---|---|---|---|---|
| `persona` | Persona | `prompt` (required), `tone` (default professional), `personality` (default helpful) | none (config node) | Compiled into the system prompt of every LLM node, after the immutable `rootSystemPrompt`. Required: a workflow without one fails validation. |
| `moderation` | Moderation | `strictness` low/medium/high, `filters[]` | none | Enables OpenAI moderation on input and final reply; flagged → canned refusal. |
| `start` | Start | — | 1 | Entry point (else first flow node with no incoming edge). |
| `knowledge` / `knowledge-source` | Your material | `sourceType` (`vector_store` with optional `collectionName`; `google_sheets` needs `sheetId`; `pdf`/`url` need `url`) | 1 | Retrieval runs once per turn via `KnowledgeConnectorService.getKnowledge`; results feed LLM nodes. Failure is logged, run continues. |
| `llm` | AI Reply | `prompt` (required), `model`, `temperature` (0.7), `maxTokens` (1000) | 1 | root prompt + persona + wrapped knowledge + last 10 history + rendered prompt → OpenAI. No key → static "I'm not able to answer that right now". |
| `response` | Fixed Reply | `template` or `message` | 1 | Renders `{{variables}}`, says it, continues. |
| `router` | Router | `conditions[] {id,type: intent\|keyword\|contains\|regex, value, label}`, `defaultRoute` | one per condition + `default` | Non-intent conditions in order first, then intent classification; edge by handle/label → `condition.route` → default. |
| `fallback` | Fallback | `message` (required), `escalation {enabled,type}` | none (ends) | Says message, may set escalate; also used when a walk produces no reply. |
| `operator-handoff` | Human Handoff | `message` | none (ends) | Sets `escalate {enabled:true,type:'operator'}`; the socket layer auto-assigns. |
| `action` | Call an API | `url`, `method`, `headers{}` (hop-by-hop forbidden), `auth {type none\|bearer\|header\|basic, header, value}` (encrypted at rest), `body` (JSON template for non-GET), `outputs[] {variable,path,fallback}`, `timeoutMs` (1–20 s, default 8 s) | `success`, `error` | SSRF-checked fetch through `services/safe-http.js`; only mapped outputs become variables; sets `action_status`, `action_error`. Preview refuses non-GET. |
| `ask` | Ask a Question | `question`, `variable`, `validate` any/email/phone/number/reference, `pattern` (≤200 chars, ReDoS-shape rejected), `maxAttempts` (3) | `next`, `invalid` | Halts with `awaiting`; next message validated; reprompts; after max attempts takes `invalid`. |
| `buttons` | Offer Choices | `question`, `variable` (default `choice`), `choices[] {id,label≤60,value}`, `maxAttempts` | one per choice + `other` | Returns `choices` (widget buttons); matches id/value/label/number/contained label. |
| `condition` | Check a Value | `clauses[] {left,operator,right}`, `match` all/any; operators equals, not_equals, contains, starts_with, is_empty, is_not_empty, greater_than, less_than, matches | `true`, `false` | String comparison (case-insensitive), numeric for gt/lt. |
| `set` | Set a Value | `assignments[] {variable,value}` | 1 | Renders and merges into variables. |
| `business-hours` | Open or Closed | `requireOperator` | `open`, `closed` | `availability.status()`; branches on `open` or `canReachOperator`; sets `opens_at`, `next_opening`. |
| `tag` | Add a Tag | `tags[]` | 1 | `$addToSet` normalised tags on the conversation. Preview: "would have". |
| `task` | Create a Task | `title`, `description`, `priority`, `dueInDays` (3) | 1 | `Task.create` with `createdByBot:true` and collected variables; webhook `task.created`; sets `task_id`. |
| `notify` | Email the Team | `to`, `subject`, `body` | 1 | SMTP via `emailChannel.buildTransport()`; fire-and-forget; skipped without SMTP. |
| `capability` | Use Your Data | `capability` (contract id), `input{}`, `limit`, `offerAsChoices` | `success`, `error` | `connector.call()`; sets `result_count`, `result_<field>`, `cards`, optional `choices`. Writes are refused in preview. |

Runtime limits: 50 steps per turn, persisted variables 50 keys × 2000 chars, cycles rejected at compile time (no loops), history last 10, action response 256 KB / 3 redirects. Template syntax `{{ name }}`; the compiler's `renderTemplate` does a flat lookup (dotted paths only work inside action-node templates). Reserved variables injected from the contact: `contact_verified`, `contact_name`, `contact_email`, `contact_external_id` (verified only). Run variables always include `user_input`, `user_message`, `knowledge_result`.

**Templates (`config/workflow-templates.js`, `GET /api/workflows/templates[/:id]`).**

| id | Name | Industry | Requires | What it does |
|---|---|---|---|---|
| `order-status` | Where is my order? | Retail / e-commerce | An order API | Ask order number → GET lookup → branch on `shipped` → reply; API error or 3 bad answers → tag `order-status` → handoff. |
| `returns` | Returns and refunds | Retail / e-commerce | Nothing | Ask order → choose reason → faulty: tag `faulty,urgent` + handoff; else ask email → tag `return,refund` → task (1 day) → confirm. |
| `triage` | Front desk | Any | Knowledge optional | Choose topic → tag → knowledge + LLM answer; "person" → business hours → open: handoff; closed: ask email → task → promise. |
| `lead-qualification` | Qualify a new enquiry | B2B / services | Nothing | Ask who/need/team size/email → tag → team ≥10: task "Qualified lead"; else self-serve reply. |
| `booking` | Book or change an appointment | Clinics, salons, trades | Nothing; a calendar under Bot → Booking makes it book for real | New: name → real free times as buttons (`capability` `availability.slots`) → email → book (`availability.book`) → "Finish booking" link or tag + confirmation; with no calendar or nothing free: when/phone → tag → task → confirm (a failed booking keeps the chosen time and joins at phone). Change: reference → tag → task → confirm. |
| `account-lookup` | Answer about their account | SaaS | Identity verification + account API | `contact_verified` check → GET account → LLM answers only from returned fields; unverified → sign-in reply; error → handoff. |
| `cancellation-save` | Cancel my subscription | SaaS | Nothing | Choose reason → tag → task (high) → confirmation; "other" → handoff. |
| `complaint` | Handle a complaint | Any | Change notify address; SMTP | Ask complaint + reference → tag `complaint,urgent` → business hours → handoff or task (urgent) + email the team. |

Each template carries a trigger: `triage` answers every message (`always`); the other seven are `intent` triggers ("where is my order", "return or refund", "a quote or new enquiry", "book, change or cancel an appointment", "a question about my account", "cancel subscription", "make a complaint").

**Triggers (`models/workflow.js#trigger`):** `{type: always|intent|keywords, description, keywords[]}`. `intent` is a sentence describing what the visitor wants; `keywords` match as whole words; `always` takes every message no other workflow took, and at most one live workflow may have it. How a message is matched is in 2.2.

**Compilation/validation (`workflow-compiler.js#validateWorkflow`):** non-empty, exactly one Persona present, unique ids (escaped and validated server-side), edges reference nodes, unknown types warned, orphan flow nodes rejected, single output on non-branching nodes (one edge per output handle), action URL/method/body checks, regex pattern checks, cycle detection. Per-node config rules live in `services/workflow.js#validateNodeData`. A draft saves with problems reported as warnings; publishing refuses an invalid graph. Messages name nodes by their labels. `POST /api/workflows/validate` always answers 200 with `{valid, errors, warnings}`.

**Preview (`POST /api/workflows/preview`):** compiles the graph from the request body (saved or not) and runs it with `simulate:true` and the conversation history so far, no session; GETs really happen, POSTs/tasks/tags/emails/connector writes are declined and reported as "would have"; returns the path of executed node ids so the editor can light them up. `POST /api/workflows/actions/test` runs one action node once and shows the raw body plus mapped outputs.

**Versioning and going live (`models/workflow.js`, `models/workflow-version.js`, `services/workflow.js`):** status `draft|published|archived`; every create/update/rollback bumps `version` and snapshots a `WorkflowVersion` (nodes, edges, trigger, compiledChain, changeDescription, `isRollback`, complexity metrics); last 20 shown; rollback copies a version forward as a new version. Several workflows can be `published` at once. Publishing records `liveVersion`, `liveTrigger` and `publishedBy`; saving a live workflow afterwards bumps `version` but visitors keep `liveVersion` (`Workflow.liveGraph`) until it is published again — the list shows "Live: v3 · Draft: v4". Publishing a second `always` workflow is a 409 naming the first unless the body says `{replace:true}`, which unpublishes it. The plan's `workflows` limit counts live workflows and is checked at publish, not creation. `POST /:id/unpublish` makes it a draft; `POST /:id/duplicate` copies it as a draft. The editor and list can rename.

**Run statistics:** `executionStats {runs, completions, handoffs, errors, lastRunAt}` counted per process and flushed to the workflow every `WORKFLOW_STATS_FLUSH_MS` (30 s) and on shutdown; `GET /api/workflows/:id/stats` reads them.

**Hot swap (`workflow-runtime.js`):** per-process cache keyed by company, holding every live workflow, trusted for `WORKFLOW_CACHE_TTL_MS` (30 s) then re-checked against the DB; publish hot-swaps on the publishing instance and emits `workflow:published` / `workflow:hot-swap`; unpublish/rollback/archive/delete of a live workflow unloads it (`workflow:unloaded`) and it reloads lazily on the next message. Action-node credentials are encrypted before save and never returned to the editor (only `hasSecret`).

### 2.4 Connector SDK and capabilities (`config/capabilities.js`, `sdk/`, `services/connector.js`, `services/safe-http.js`)

A tenant installs `@chatbot-platform/connector-sdk` (`sdk/index.js`, zero dependencies, Node ≥18, **not published to any registry in-repo**), implements the methods that apply, and exposes one URL. Contract:

| Capability | Kind | Input | Returns |
|---|---|---|---|
| `catalog.search` | read | `{query: string, limit?: number}` | list of `Product {id, title, price?, currency?, image?(url), url?(url), description?, inStock?}` |
| `catalog.get` | read | `{id: string}` | one `Product` |
| `availability.slots` | read | `{service?, from?(date), to?(date), limit?}` | list of `Slot {id, startsAt(date), endsAt?, label?, staff?}` |
| `availability.book` | write | `{slotId, name?, email?, phone?, notes?}` | one `Booking {id, startsAt, reference?, status?, title?, url?}` (`status: 'link'` + `url` when the visitor must finish booking elsewhere) |
| `availability.cancel` | write | `{reference, email?}` | one `Booking`; the visitor must be in the conversation it was booked from, or give the email it was booked under |

When a calendar is connected under **Bot → Booking**, `services/connector.js` sends the three `availability.*` capabilities to `services/booking` instead of the tenant's URL (2.13); a company can have a calendar and no hosted connector, in which case `settingsFor` returns `{url: null, capabilities: [those three], calendar: true}`.

- **SDK API:** `createConnector({searchCatalog, getProduct, listSlots, bookSlot, cancelBooking}, {secret?})` → `(req,res)` handler. `GET` answers discovery `{protocol:'chatbot-platform/connector', version, capabilities[], signed}`; `POST` reads the raw body (≤256 KB, refuses a pre-parsed body), verifies the signature, dispatches, coerces the result to the shape. Also exports `verifySignature`, `SDK_VERSION`, `CAPABILITY_METHODS`, `MAX_CLOCK_SKEW_SECONDS`, plus TypeScript types.
- **Signing:** header `X-Connector-Signature: t=<unix>,v1=<hex>`; `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`; ±300 s window; constant-time compare. Secret `csec_<48 hex>` minted by the platform, shown once, encrypted at rest; read by the SDK from `CHATBOT_CONNECTOR_SECRET`. No nonce store (replay within 5 minutes is not detected).
- **Platform side (`services/connector.js`):** settings in `Company.connector {enabled, url, secret, capabilities[], sdkVersion, lastCheckedAt, lastError}`; managed under **Developers → Your systems** (`GET/PUT /api/companies/me/connector`, `POST …/check` runs discovery and must succeed before the connector can be switched on; `GET …/sdk` names the package and version that ships in `sdk/`). `call()` validates input against the contract, refuses capabilities the connector did not advertise, caches reads 10 s, times out at 8 s, no retries, validates results (bad rows dropped, `truncated` flag, `maxItems` 25), never throws. Writes in preview return `simulated`.
- **Outbound safety (`safe-http.js`, used for connector, action nodes, webhooks, knowledge imports):** https only unless `ACTIONS_ALLOW_HTTP`, refuses private/loopback/link-local/CGNAT/multicast/IPv6-local and v4-mapped ranges at DNS-resolution time (rebinding-safe), re-validates on each of up to 3 redirects and drops credentials on host change, 256 KB response cap.
- **Consumers:** the `capability` workflow node, and the assistant, which is offered each enabled capability as a tool (`services/assistant-tools.js`; writes need a confirmed repeat in a later turn, at most three calls and one write per turn).

### 2.5 Integrations

**Action-node presets (`client/workflow-editor/editor.js` `ACTION_PRESETS`, browser-only; nothing service-specific exists server-side):**

| Preset | Request | Auth | Outputs → variables |
|---|---|---|---|
| Shopify — look up an order | GET `https://{{shop_domain}}.myshopify.com/admin/api/2024-07/orders/{{order_id}}.json` | header `X-Shopify-Access-Token` | `order.financial_status`→`payment_status`, `order.fulfillment_status`→`fulfillment_status` |
| Stripe — check a subscription | GET `https://api.stripe.com/v1/customers/{{customer_id}}/subscriptions` | bearer (restricted key) | `data.0.status`→`subscription_status`, `data.0.current_period_end`→`current_period_end` |
| Zendesk — raise a ticket | POST `https://{{subdomain}}.zendesk.com/api/v2/tickets.json` with subject "Chat escalation" and `{{user_input}}` | basic `email/token:api_token` | `ticket.id`→`ticket_id` |
| Slack — post to a channel | POST `https://hooks.slack.com/services/{{webhook_path}}` `{"text": "New conversation needs attention: {{user_input}}"}` | none (URL is the secret, stored in plaintext) | — |
| HubSpot — look up a contact | GET `https://api.hubapi.com/crm/v3/objects/contacts/{{contact_email}}?idProperty=email` | bearer (private app token) | `properties.firstname`→`crm_first_name`, `properties.lifecyclestage`→`crm_lifecycle_stage` |

`{{shop_domain}}`, `{{subdomain}}`, `{{webhook_path}}` are workflow variables and render empty unless the author replaces them.

**Outbound webhooks (`services/webhooks.js`, `routes/webhooks.js`, `models/webhook.js`, `models/webhook-delivery.js`):**

| Event | Dispatched from | Payload `data` |
|---|---|---|
| `conversation.started` | `services/conversation-lifecycle.js` (the visitor's first action, not the page load; a new messaging-app thread), `services/email-channel.js` (a new email thread) | sessionId, channel, domain, contactId, startedAt |
| `conversation.ended` | socket `end-chat`, `POST /api/admin/chat/:id/end`, and the idle sweep (`services/conversation-sweeps.js`, web chats only, `endedBy: 'idle'`) | sessionId, endedBy, operatorName, messages, startedAt, endedAt, tags, outcome |
| `conversation.tagged` | `PUT /api/admin/chat/:id/tags` | sessionId, tags, taggedBy |
| `conversation.rated` | `services/csat.js` | sessionId, score, comment, handledBy, operatorName, ratedAt |
| `operator.assigned` | `services/assignment.js`, `POST …/claim` | sessionId, operatorId, operatorName, method |
| `contact.created` | `services/contacts.js` | contactId, name, email, identityLevel, sessionId |
| `contact.identified` | `services/contacts.js` (on becoming verified, and on going from email-code to signed) | contactId, externalId, name, email |
| `task.created` | workflow `task` node, and tasks people create (`routes/task.js`, follow-ups included) | taskId, title, priority, dueDate, sessionId, raisedBy (workflow); taskId, title, priority, dueDate, status, assignee, parentTaskId … (people) |
| `booking.created` | `services/booking` (a confirmed booking by the bot or an operator, and the new booking a reschedule makes; not a Calendly link booking, which is only `pending`) | bookingId, reference, provider, serviceId, service, startsAt, endsAt, timezone, status, name, email, phone, sessionId, createdBy, rescheduledFrom? |
| `booking.cancelled` | `services/booking` (visitor by reference, or an operator) | the same, with cancelledBy |

Body `{id, event, createdAt, data}`; headers `x-webhook-event`, `x-webhook-id`, `x-webhook-signature: t=<unix>,v1=<HMAC-SHA256(secret,"<t>.<body>")>`; 10 s timeout. Retries: 5 attempts at 30 s / 2 m / 10 m / 1 h for network errors, 5xx and 429; other 4xx fail immediately; 20 consecutive failures disable the endpoint with a reason. Retries are rows (`WebhookDelivery`, TTL `WEBHOOK_LOG_RETENTION_DAYS` = 30) swept every minute by `services/scheduler.js`. Secrets `whsec_<48 hex>`, encrypted at rest, shown once, rotatable. Dashboard **Developers → Webhooks**: create/edit/enable/rotate/test/delete, a delivery log, and **Redeliver** on a delivery that has given up (`POST /api/webhooks/:id/deliveries/:deliveryId/redeliver`; one still pending is refused, since it will be retried anyway).

**Public read API (`routes/public-api.js`, `middleware/api-key.js`, `services/api-keys.js`):** `/api/v1`, `Authorization: Bearer ck_…` (or `x-api-key`); keys created under Developers → API keys (with an optional expiry), hashed (SHA-256), prefix lookup, shown once, optional expiry, revocable (row kept). Scopes `conversations:read`, `contacts:read`, `tasks:read`. Plan feature `apiAccess` checked on every request (402 otherwise); rate limit per key from plan `apiRequestsPerMinute`. Cursor paging by `_id` (`limit` 1–100, default 25; `{data, nextCursor, hasMore}`), `since`/`until` filters. Endpoints: `GET /me`, `GET /conversations` (+`status`, `tag`), `GET /conversations/:sessionId` (with transcript), `GET /contacts` (+`email`, `externalId`), `GET /tasks` (+`status`). Read-only.

**Email channel (`services/email-channel.js`, `routes/email.js`):** inbound `POST /api/email/inbound/:companyId/:provider?` with provider `generic|sendgrid|mailgun|postmark` (no IMAP/SES), authenticated only by the per-company `emailChannel.inboundSecret` (preferably the `X-Inbound-Secret` header; `?secret=` and the body are still accepted), no provider-signature verification; unknown company and disabled channel both 404. Each accepted email stamps `emailChannel.lastInboundAt`. Messages are deduped by `Message-ID`, threaded by `In-Reply-To`/`References` then sender + normalised subject, quoted history stripped, and become a `Conversation {channel:'email', sessionId:'email-<hex>'}` linked to a Contact by email (firing `conversation.started` when new); operators see `new-chat`/`new-message` with `channel:'email'`. The bot never auto-replies to email. Outbound is SMTP only (`EMAIL_HOST/PORT/SECURE/USER/PASS`), sent from the operator composer with `Re:` subject, own `Message-ID`, threading headers, `X-Operator`, and the tenant's signature. **Sender (`senderFor`):** `From: "<fromName or company> (via PRODUCT_NAME)" <EMAIL_FROM>` with `Reply-To` the tenant's inbound or from address; with `EMAIL_ALLOW_TENANT_FROM=true`, `From:` the tenant's own address. With no `PRODUCT_NAME` the display name reads "(via our support desk)". **Follow-ups (`sendFollowUp`):** an operator's message to a chat visitor who is no longer connected and has an email address goes by email (the answer, the signature, their last question quoted; "replies are not read" when there is no Reply-To), with a system line in the transcript and `operator-message-emailed` to the operator; `POST /api/admin/chat/:id/follow-up` does the same for an ended chat. Without `EMAIL_HOST`/`EMAIL_FROM` the operator is told why it was not sent. Settings under **Channels → Email** (`GET/PUT /api/companies/me/email`, `POST …/email/test` sends a test to the admin); the GET re-shows the inbound URL including the secret, `lastInboundAt`, and the sender customers will see.

**Google Sheets (`routes/google.js`, `services/googleAuth.js`, `services/googleSheets.js`, `services/userGoogleDrive.js`, `services/knowledge.js`, `models/knowledgeDocument.js`, `models/googleToken.js`):** a dashboard user connects their own Google account (OAuth scopes `spreadsheets.readonly`, `drive.readonly`, `userinfo.email`; signed state with 10-minute TTL; tokens stored per user, in plaintext, auto-refreshed), searches Drive for spreadsheets, picks a sheet, excludes columns, and imports rows as a `KnowledgeDocument {userId, spreadsheetId, sheet, title, columns[{name,exclude}], rows[][]}`; documents can be listed, viewed, refreshed, column-edited and deleted. **The assistant does not read these documents:** `KnowledgeDocument` is referenced only by `services/knowledge.js` and `services/tenant-backup.js`; nothing in `services/ai.js`, `services/vector-store.js`, `services/knowledge-connector.js`, `services/reply.js` or the workflow runtime touches it, and the documents are keyed by user rather than company. The only path from a sheet into `KnowledgeChunk` is `knowledge-connector.js#loadGoogleSheets` (platform service account, reachable from a workflow knowledge node with `sourceType: google_sheets`), which calls the google-spreadsheet v3 API (`new GoogleSpreadsheet(id)` + `useServiceAccountAuth`) against the installed v4.1.4 and is therefore likely broken at runtime. Routes answer 503 when `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` are unset. The UI is `client/admin/sheets.js`, a card on **Bot → Knowledge** that is hidden unless `GOOGLE_SHEETS_UI=true` (`GET /api/knowledge` reports `features.googleSheets`); the code is kept until the owner decides what to do with it. This is unrelated to Google *sign-in* (`/api/auth/google/*`, 2.11).

### 2.6 Operator inbox (`websockets.js`, `services/conversation-lifecycle.js`, `routes/admin.js`, `services/assignment.js`, `services/availability.js`, `services/csat.js`, `services/contacts.js`, `services/task.js`, `services/notification.js`, `client/admin/inbox.js`, `operator-tools.js`, `suggestions.js`, `tags.js`, `history.js`, `contacts.js`, `tasks.js`, `notifications.js`, `teach.js`)

- **Queue:** `GET /api/admin/active-chats`; Mine (assigned to me) / Waiting (handed over, nobody holding it) / All with live counts, search, tag filter, sorted by longest wait; empty rows left by older versions are excluded. Rows show the real message count, a last-message preview, a live "waiting Nm" timer, a reason badge (Asked for a person / Bot couldn't answer / Bot error / Out of AI replies / Left a message), email badge, tags, unread badge, "Disconnected". Real-time via `new-chat` (at the visitor's first action), `new-message`, `conversation-message` (every stored message, system lines included), `handoff-requested` (reason, visitor name, what they asked), `operator-requested`, `chat-activity`, `chat-reactivated`, `operator-joined/left`, `chat-assigned`, `conversation-tagged`, `conversation-note`, `conversation-note-deleted`, `conversation-deleted`, `conversation-rated`, `message-feedback`. New chats, hand-overs, assignments and transfers raise a toast naming the visitor with an Open button, a desktop notification and a sound; an "only when I'm needed" preference limits them.
- **Messaging-app conversations (2.14):** the same queue, transcript and composer, with a WhatsApp/Messenger/Instagram badge, the reply window shown in the composer (`GET /api/channels/conversations/:sessionId/window`), and "send the approved template" when a WhatsApp window has closed. History filters by app; People's timeline marks app conversations. "Ask for details" and attach are hidden on them.
- **Long waits (`services/conversation-sweeps.js#escalateLongWaits`, every minute):** a conversation nobody holds whose visitor has waited for a person longer than `Company.routing.escalateAfterMinutes` (default 5, 0 off; **Team → Routing**) raises a `visitor_waiting` notification (bell and push) to every admin and to operators taking chats, once per wait (`handoff.escalatedAt`, claimed atomically).
- **Idle close (`closeIdleConversations`, hourly at :05):** an active web chat (`channel` chat or unset) nobody holds and nobody has written in for `IDLE_CLOSE_HOURS` (24) is ended (`chat-ended {reason: 'idle'}` to operators, `conversation.ended` with `endedBy: 'idle'`). Email and app threads are left open.
- **Hand-over (`lifecycle.handOver`):** every route to a person (see 2.2) records `handoff {requestedAt, reason, summary}` (the summary is "Asked: …", the visitor's last three messages) and `awaitingOperatorSince`, writes a system line, says the tenant's `handoff` canned reply (or the `reply_failed` notice), alerts operators once (not once per message), tries assignment, and tells the visitor one of three things: someone has it (`operator_joined`), someone will (`queued`), or nobody can be reached — closed, or nobody online and taking chats — so leave an email (`queued_offline` + `followup-request`).
- **Assignment (`assignment.js`):** only when `company.routing.autoAssign` is on; candidates are operators currently in the `operators:<companyId>` socket room, `isActive` and `acceptingChats`, under capacity (`user.maxConcurrentChats` → `company.routing.maxConcurrent` → 3); pick least-loaded, tie → longest idle, tie → stable id. Atomic claim (`findOneAndUpdate` on `operatorId` null); the assignee is notified (`chat_assigned`). Triggered by a hand-over, conversation start if `routing.assignOnStart`, and `release` (operator leave with `passToBot:false`, deactivation, or disconnect after the grace period). Everyone busy → the conversation waits, the bot keeps answering, and nothing re-sweeps until the next trigger. No skills/language/priority routing.
- **Manual takeover / claim:** socket `operator-takeover` or `POST /api/admin/chat/:id/claim` (409 if held). The holder re-joining (a reload) is silent: `operator-rejoined` to them only, no announcement to the visitor, no workflow reset, no AI call. Taking a chat from a colleague needs company_admin/superadmin and `force:true` (the colleague gets `chat-taken-from-you`). Takeover clears `workflowState`, sets `operatorEverJoined` and `firstOperatorJoinedAt`. Which chats a person had open is restored from the server per user after a reload.
- **Transfer:** `GET /api/admin/chat/:id/transfer-targets` lists operators and admins with presence; `POST …/transfer {operatorId, note}` refuses someone offline or not taking chats (409), writes a system note, notifies the target (`chat-transferred-to-you` and a `chat_transferred` notification); visitor gets `chat-transferred`. Not atomic.
- **Holder only:** only the person holding a chat can end it, leave it or transfer it; an admin can, after a dialog that names the holder, by sending `force: true`, which the server requires (socket `heldByColleague` check, REST `mayActOn`).
- **Leave / end:** `operator-leave {passToBot}` (bot resumes, or re-queue and try a colleague); `end-chat {outcome:{status, note}}` / `POST …/end` sets `ended`, records `outcome` (`resolved|follow_up|unresolved|spam`, private note ≤500), clears operator and workflow state, writes a system line, asks for a rating if the visitor wrote at least once, dispatches `conversation.ended`. A visitor message on an ended chat reactivates it (`chat-reactivated`).
- **Reply by email:** an operator message to a visitor who has left (no socket in their room) and gave an email goes by email (`operator-message-emailed`); `POST /api/admin/chat/:id/follow-up` answers an ended chat the same way. See 2.5.
- **Transcript:** system lines (transcript events for operators only; never sent to the visitor or the model), a hand-over strip (reason, when, what they asked), the unanswered marker, the visitor's thumbs, sources, file chips both ways, a "Fixed" badge on corrected answers; **Teach the bot** on bot messages and, for admins, **Save as the bot's answer** on operator replies (2.12). Read receipts reach the visitor when the holder views the conversation (`operator-read`).
- **Notes:** internal notes (≤5000 chars) via `POST/DELETE /api/admin/chat/:id/notes`, de-duplicated, deletes broadcast (`conversation-note-deleted`); never shown to the visitor or the model; system notes (transfers) are not deletable.
- **Saved replies:** `/` prefix or button in the composer opens a picker over `GET /api/templates/mine` (arrow keys to choose; `{name}`, `{email}`, `{operator}` filled in); inserts into the composer, never auto-sends. "Ask for details" and attach are hidden on email conversations.
- **AI suggestions:** "Get Suggestion" per visitor message → `request-suggestions`; card with Use / Edit / Dismiss → `use-suggestion`; the per-conversation switch (`toggle-suggestions`) sits in the composer; hidden on plans without `aiSuggestions`; a failed draft is reported, never offered.
- **Multi-chat, typing, details:** several chats at once; typing indicators both ways; visitor detail request (`request-user-details`); edit contact info (`POST …/contact-info`, which updates the Contact record and shows server validation messages).
- **Attachments:** `POST /api/admin/conversations/:sessionId/files` (same allowlist and cap as visitor uploads; delivered as an `operator-message` with `fileId`/`fileName`/`fileUrl`).
- **Tags:** free-form, normalised (lowercase, ≤40 chars, max 20), suggestions from `GET /api/admin/tags`, `PUT …/tags`; queue filter by tag; workflow `tag` node.
- **Availability:** `GET/PUT /api/admin/me/availability {acceptingChats, maxConcurrentChats}` (the header switch now loads the real state). Business hours per company in an IANA timezone with per-weekday open/close minutes, overnight ranges, whole closed dates (`closedDates`), `offlineMessage`, browser timezone as the default (`GET/PUT /api/companies/me/hours`); status `{open, canReachOperator, operatorsOnline, opensAt}` feeds the widget, the hand-over and the `business-hours` node. Presence is read from socket rooms, not a status table; `GET /api/admin/operators/online` lists who is connected for Home.
- **CSAT (`csat.js`):** requested on end if the visitor wrote at least once and was not asked before; 1–5, satisfied ≥4; recorded on first tap, comment may be added later, score never revised; attributed to the last operator in the transcript or `bot`; `decline-rating` remembered. A score ≤2 notifies the operator who handled it, or the company's admins when the bot did (`low_rating`). Summary on every plan; by-handler, by-operator and comments in the advanced report; a rating comment opens its conversation.
- **Contacts / identity (`contacts.js`, `models/contact.js`):** levels `anonymous` → `claimed` (typed an email) → `verified`, with `verifiedBy` `jwt` or `hmac` (the tenant signed it, 2.15) or `email_code` (a code sent to the address), and `verifiedAt`. A JWT's `attrs` are kept as `signedAttributes`; an unsigned value never replaces a signed one. Resolution order: verified externalId → known sessionId → claimed email; verified id owned by another contact merges into it. A typed email never threads a session onto a verified contact, and an email-code session never joins a signed contact. A contact is created only when a conversation is, never for a page view. Dashboard **People**: search, verified and tag filters, badges, "verified by", attributes marked signed or not, edit, conversations that open their transcript, a timeline (with app badges), a duplicate-email warning, merge (`POST /api/contacts/:id/merge`, audited), GDPR export and erase (2.9), CSV export (`GET /api/contacts/export`, admin, audited, formula-safe). Identity secret shown/rotated under **Developers → Identity verification** with JWT (recommended) and HMAC examples carrying the real widget key.
- **Tasks (`task.js`, `models/task.js`, `client/admin/tasks.js`):** title/description/dueDate/priority (`low|medium|high|urgent`)/assignee (operators and admins, `GET /api/tasks/assignees`)/status (`open|in_progress|completed`)/conversation link/contactInfo/parent (follow-ups)/`createdByBot`; My tasks / Unassigned / Overdue / All, conversation filter chip, paging, local due dates, a Bot badge; comments (add, edit and delete own); reassignment notifies (`task_assigned`); activity feed (`models/activity.js`). Real-time `task-*` and `comment-*` events to the company room; `task.created` webhook for every task.
- **Notifications (`notification.js`, `models/notification.js`):** in-app bell plus live delivery (`notification-created` to `user:<id>`), each with a `link` (and `sessionId` for chats): `task_due_tomorrow`, `task_due_today`, `task_overdue` (scheduler, midnight and hourly 08–18, server-local time), `task_assigned`, `chat_assigned`, `chat_transferred`, `low_rating`, `usage_warning`, `visitor_waiting` (the long-wait sweep). `notifyUser` also sends Web Push to the person's devices for `chat_assigned`, `chat_transferred`, `visitor_waiting`, `task_assigned`, `low_rating` and `usage_warning` (2.17). Mark read / all, delete, load more; TTL 30 days.
- **Chat history (`client/admin/history.js`):** clickable rows; search by name, email or tag; filters for date, channel, status, handled by, rating, outcome and tag; delete inside the conversation (admin-only, audited, also removes its files); CSV export honouring the filters (`GET /api/admin/export`, admin-only, audited, formula-safe via `utils/csv-export.js`); "Reply by email" on ended chats.
- **Not present:** skills, per-operator availability set by an admin, SLAs.

### 2.7 Analytics (`routes/admin.js`, `services/analytics.js`, `services/csat.js`, `client/admin/analytics.js`, `client/admin/home.js`)

Every report counts only conversations somebody started (`analytics.engaged`: the visitor wrote, or left contact details), uses one window for every number and chart (`?days=`), and works in the tenant's timezone. A metric that fails comes back `null` and is named in `unavailable`, so the screen says "unavailable" rather than 0%. A superadmin picks the tenant (`?companyId=`) or sees all tenants aggregated.

- **Basic (`GET /api/admin/analytics?days=`, every plan):** active chats, chats in the window, average response time (a person's first response), activity line, traffic sources (by `domain`), conversation metrics (total, average duration, messages per conversation, change on the previous window), volume and response-time charts, CSAT summary.
- **Advanced (`GET /api/admin/analytics/advanced?days=7|30|90`, plan `analytics === 'advanced'`, 402 otherwise):** `deflection {eligible, deflected, escalated, rate}` (escalated = a person ever joined, `operatorEverJoined`), `abandonment {total, unanswered, rate}`, `peakHours` (weekday × hour heatmap in the tenant's timezone), `operators[] {conversations, replies, avgResponseSeconds, medianResponseSeconds}` (ended chats included), `topics[]` (top 12 term frequency over ≤2000 conversations, any script), `tasks {created, completed, overdue, completionRate, avgCompletionHours}`, `satisfaction` (summary + byHandler + byOperator ≤50 + comments ≤25).
- **Value report (`GET /api/admin/analytics/value?days=`, every plan; `…/value/export` CSV):** `conversations`, `botResolved` (the visitor wrote at least once, the bot answered, no person joined and nobody asked for one, the bot's last answer was not flagged unanswered, and the visitor did not rate it 1 or 2), `handedOver`, `resolutionRate`, `hoursSaved` (bot-resolved × `minutesPerConversation`, 6 by default, per company in `Company.reports.minutesPerConversation` via `PUT /api/admin/analytics/settings`), `aiReplies` (model-written replies), `costPerResolution` (plan price for the window ÷ bot-resolved), `csatBot` / `csatHuman`, and a `definition` object with each definition in plain words. Also shown on Home.
- **Home cards:** the setup checklist, the value report, unanswered questions (2.12), usage against the plan, who is online, and "waiting" (handed over, nobody holding it).
- No custom date ranges beyond the window, daily series, or percentiles beyond median.

### 2.8 Billing and plans (`config/plans.js`, `models/subscription.js`, `services/usage.js`, `services/usage-alerts.js`, `services/billing.js`, `services/stripe.js`, `routes/billing.js`, `middleware/quota.js`, `client/admin/billing.js`)

| | Trial | Basic | Professional | Agency | Enterprise |
|---|---|---|---|---|---|
| Price / month | $0 (14 days, `TRIAL_DAYS`) | $29 | $99, or per resolution | `PLAN_AGENCY_PRICE` (299) | negotiated (`null`) |
| Conversations / month | 100 | 500 | 5 000 | 5 000 | unlimited |
| AI responses / month | 500 | 2 000 | 25 000 | 25 000 | unlimited |
| Operator seats (operators only; admins free) | 2 | 1 | 10 | 10 | unlimited |
| Knowledge chunks | 500 | 2 000 | 25 000 | 25 000 | unlimited |
| Live workflows | 1 | 1 | 10 | 10 | unlimited |
| Saved actions + enabled MCP tools | 5 | 3 | 25 | 25 | unlimited |
| API requests / minute | 60 | 120 | 600 | 600 | 3 000 |
| Workflows, knowledge base, file uploads, actions | yes | yes | yes | yes | yes |
| AI suggestions | yes | yes | yes | yes | yes |
| WhatsApp, Messenger, Instagram (`channels`) | yes | no | yes | yes | yes |
| Analytics tier | basic | basic | advanced | advanced | advanced |
| Public API access | no | no | yes | yes | yes |
| Custom branding (white-label, for an agency) | no | no | no | yes | yes |
| Priority support | no | no | no | no | yes |

The Agency plan also carries `agency {clientsIncluded (PLAN_AGENCY_CLIENTS_INCLUDED, 10), perClientPrice (PLAN_AGENCY_CLIENT_PRICE, 19), clientPlan (PLAN_AGENCY_CLIENT_PLAN, professional)}` and is offered only to a company with `agency.isAgency`. Professional carries `pricing {model: 'flat', options: ['flat','per_resolution'], perResolution (PRICE_PER_RESOLUTION, 0.49), includedResolutions (PRICE_INCLUDED_RESOLUTIONS, 0), baseFee (PRICE_PER_RESOLUTION_BASE, 49)}`. All of these are read from the environment at start-up (`PRICING_ENV`) because none has been decided. Booking and MCP servers need the `actions` feature, which every plan has.

- **Subscription (`models/subscription.js`):** one per company, lazily created on `trial`; `status trialing|active|past_due|cancelled|suspended`; `trialEndsAt`; `limitOverrides` map (negative = unlimited); `overageAllowed`; `pricingModel flat|per_resolution`; `spendCap` (money, resolutions only) and `spendCapUpdatedAt`; `managedByAgency` (an agency pays for this client's plan); Stripe `externalCustomerId/SubscriptionId`; `externalEventAt` ordering guard. `isEntitled()` is false for cancelled/suspended/expired trial; **`past_due` still entitles**. Trial expiry is computed at read time (`effectiveStatus() === 'trial_expired'`); nothing flips the stored status. The `resolutionSpend` meter's limit is the cap, and only for a per-resolution subscription.
- **Metering (`services/usage.js`, `models/usage.js`):** monthly document per company (`YYYY-MM`, UTC — the new month is a new document, no reset job) counting `conversations` (at the visitor's first action, not a page view), `messages`, `aiResponses` (only replies a model wrote), `operatorMessages`, `filesUploaded`, `fileBytes`, `limitHits`, and `resolutions` (with `resolutionsCountedAt` and `stripeReport {reported, day, pending}`, 2.18); seats (`role: 'operator'`, active or invited), live workflows, actions (saved Actions plus switched-on MCP tools), chunks and resolution spending are counted live. `Subscription.forCompany` survives concurrent first calls (a duplicate-key race re-reads). `knowledgeChunksIngested` exists on the schema but is never incremented.
- **Warnings (`services/usage-alerts.js`, hourly at :45):** consumption meters (conversations, AI replies, knowledge chunks, and resolution spending against the cap) at 80% and 100%; capacity meters (seats, live workflows, actions) only when over. Each is claimed once per meter and period (`Company.usageAlerts`; a new cap clears its claim) and goes out as an email to the admins (`SMTP_*`), a bell notification (`usage_warning`, also pushed) and the banner (`GET /api/billing/me/status`).
- **Enforcement (`middleware/quota.js`):** `enforceLimit(meter)` → 402 `{code:'PLAN_LIMIT_REACHED', meter, limit, used, planId}`; `requireFeature(feature)` → 402 `FEATURE_NOT_IN_PLAN`; superadmin bypass; **fail open** on internal error. Applied to operator invitation/creation/reactivation (operators only), workflow **publish** (live count), action creation and switching an MCP tool on (one shared limit), knowledge import (twice: before fetch and after chunking), conversation creation and AI replies (socket and REST; a spent AI allowance hands the conversation over rather than stopping it), file uploads, API keys (per request), advanced analytics, booking and MCP screens (`actions`), messaging-app settings (`channels`, also checked on every inbound message), and the per-minute rate limiter (a signed-in dashboard user gets at least `RATE_LIMIT_DASHBOARD_MIN`, 300). `overageAllowed` lets `check()` pass beyond the limit — **nothing bills for it**. `customBranding` is read by `services/agency.js` (2.18); `prioritySupport` is never read.
- **Stripe (`services/stripe.js`, no SDK):** `POST /api/billing/webhook/stripe`: signature verified over `req.rawBody` (captured only for `/api/billing/webhook*`), 300 s tolerance, `StripeEvent` idempotency ledger (TTL 30 days), events older than `externalEventAt` ignored. Handles `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` (→ `past_due`); price → plan via `STRIPE_PRICE_BASIC/PROFESSIONAL/AGENCY/ENTERPRISE` or the subscription's `metadata.planId`; pricing model from `metadata.pricingModel` or the presence of the metered price; tenant via `metadata.companyId` or `client_reference_id` (only if `STRIPE_ALLOW_CLIENT_REFERENCE=true`); unknown price leaves the plan alone. Unrecognised events and unmatched customers are acknowledged with 200. With `STRIPE_SECRET_KEY`: `POST /api/billing/checkout {plan, pricing?: 'per_resolution'}` (Checkout Session, `{url}`; 409 when already subscribed; a per-resolution session carries the base-fee price `STRIPE_PRICE_<PLAN>_PER_RESOLUTION` and the metered `STRIPE_PRICE_RESOLUTION`, anchored to the first of next month; `agency` only for an agency), `POST /api/billing/portal` (Billing Portal, `{url}`), `GET /api/billing/invoices` (the tenant's Stripe invoices). Checkout, portal and spend cap are refused while an agency works in a client's dashboard (`notWhileActing`). Meter events: `POST /v1/billing/meter_events` with `event_name` `STRIPE_RESOLUTION_EVENT` (default `resolutions`), `payload {stripe_customer_id, value}`, `identifier` = Idempotency-Key = `res_<company>_<YYYY-MM>_<day>` (2.18).
- **Superadmin:** `PATCH /api/billing/companies/:id/subscription {planId, status, pricingModel, overageAllowed, currentPeriodEnd, limitOverrides, externalCustomerId, externalSubscriptionId}` (audited `plan.changed`), `GET /api/billing/usage?period=YYYY-MM` (every tenant, zeros for a quiet month, trials ending within a week, tenants never installed, estimated AI cost = AI replies × `AI_COST_PER_REPLY`), `GET /api/billing/companies/:id`. Same `applySubscriptionChange` function as the webhook.
- **Dashboard Account → Plan & billing:** catalogue cards (AI-reply limits, plurals, no unbuilt bullets; the Agency card only for an agency) with a Choose button per purchasable plan and, where configured, "pay per resolution"; for a per-resolution tenant the month's resolutions with their definition, the amount, a projection and the spending cap form (`PUT /api/billing/me/spend-cap`); the Billing Portal link, current plan and status, trial countdown and an expired-trial alert, usage meters, invoices, a 12-month history chart; a banner on every screen at 80% and 100%; superadmin sees **Platform → Usage by tenant** with a month picker and a Change-plan modal.

### 2.9 Security and compliance

- **Tenant isolation:** `utils/query.js#companyFilter`/`companyScope` on REST; socket handlers check `canOperateOn(sessionId)` (conversation.company must equal the operator's company; superadmin passes); visitors act only on the session bound by `resume-session`; `join` refuses reserved rooms; the widget's origin must be one of the named tenant's own `allowedDomains` (`tenant.isOriginAllowed`), on the socket and for HTTP CORS with `?key=` (`server.js#corsPolicy`); a domain registered by another tenant is refused (409 `DOMAIN_TAKEN`); a self-signed-up company cannot add domains until its admin's email is confirmed (403 `EMAIL_NOT_VERIFIED`, `middleware/auth.js#domainsNeedVerifiedEmail`).
- **Staff auth:** JWT (8 h, `{id, username, role, company, tv, jti}`) in `x-auth-token` (REST) or handshake `auth.token` (socket). `POST /api/auth/logout` revokes this token's `jti` (`RevokedToken`, TTL to the token's expiry); `logout-everywhere`, a password change or reset, and deactivation bump `tokenVersion`, ending every session. `middleware/auth.js#auth` refuses a revoked `jti`, a stale version, a deactivated or pending-invite user, and anyone (but a superadmin) whose company is deactivated (`COMPANY_DEACTIVATED`, company status cached briefly). The socket refuses the same at connect and re-checks every `SOCKET_REAUTH_MS` (60 s), sending `session-expired {reason}` and disconnecting; `socketManager.disconnectUser` does it at once (deactivation, company switched off). Passwords bcrypt(10), min 8 (12 for superadmin); forgot/reset by SHA-256 token with 1 h expiry via `SMTP_*`; `GET /reset-info` tells the form the minimum length. Sign-in by email or username; a pending invitation is told to use its email rather than "wrong password". Google sign-in (2.11) only for existing, active accounts with a Google-verified address. Rate limits (`middleware/rateLimiter.js`, MongoDB-backed so they hold across instances): login per address+account (10/h, failures only) and per address (50/h), password reset 5/h, sign-up 5/h per address (every request counts), emailed links 30/h per address (failures only), confirmation resends 5/h per person, chat and API per tenant/user with the allowance from the plan; superadmins skipped; in-memory fallback if MongoDB is unreachable.
- **Visitor session tokens (`services/session-token.js`):** 32 random bytes, SHA-256 hash stored on the conversation (`select:false`), required for `resume-session`, `POST /api/chat/*`, and `POST /api/upload`; legacy conversations without a hash are accepted once and upgraded.
- **API keys:** see 2.5; SHA-256 hashed, prefix-indexed, constant-time compare, per-key rate limit, plan-checked per request, revocation immediate, audited.
- **Secrets at rest (`services/secrets.js`):** AES-256-GCM, key from `SECRETS_KEY` else HKDF of `SESSION_SECRET` (warned); encrypted: action-node `auth.value`, `Webhook.secret`, `Company.connector.secret`, `ChannelAccount.accessToken/appSecret`, `CalendarConnection.credentials` (API key, access and refresh tokens), `McpServer.auth.secret`. **Not encrypted** (only `select:false` or nothing): `Company.identitySecret`, `Company.emailChannel.inboundSecret`, `ChannelAccount.verifyToken` (a value Meta echoes, not a credential to anything), `GoogleToken.accessToken/refreshToken` (the Sheets import's, not the calendar's).
- **Inbound signatures:** Meta webhooks are verified with HMAC-SHA256 of the raw body under the tenant's app secret (`X-Hub-Signature-256`), constant-time, before anything is parsed; `/api/channels/webhook` is read raw (`express.raw`, 1 MB) ahead of the JSON parser. The Google Calendar callback trusts only an HMAC-signed state (company, user, nonce, ten-minute life) whose nonce matches an httpOnly cookie set for the browser that started the flow, and re-checks that user is still an admin of that company.
- **Agency acting-as:** a token with `actingAs {companyId, by}` (one hour) makes its bearer a `company_admin` of that client for that request only if the client still belongs to the bearer's agency and the agency is still one; display name becomes "Name (Agency)"; every request is audited `agency.acted_as` (method and path) on the client's log; `notWhileActing` refuses checkout, portal and spend cap; agency routes refuse an acting token. The socket follows the same scope (`actingSocketScope`, not taking chats).
- **Audit log (`services/audit.js`, `models/audit-log.js`):** append-only (no update/delete route), actor copied not joined, secret-looking keys redacted, TTL `AUDIT_RETENTION_DAYS` (400). Actions: `auth.login/logout/logout_everywhere/password_change/password_reset_requested/password_reset`, `superadmin.created`, `company.signed_up/created/updated/activated/deactivated/deleted`, `company.hours_changed/routing_changed/retention_changed/user_password_reset`, `user.created/email_verified/invite_accepted`, `operator.invited/invite_resent/invite_revoked/created/activated/deactivated/updated/role_changed/deleted/password_reset`, `plan.changed` (superadmin and `stripe` system actor), `billing.checkout_started`, `api_key.created/revoked`, `webhook.created/updated/deleted/secret_rotated/redelivered`, `workflow.published/unpublished/duplicated/trigger_changed/rolled_back/deleted`, `knowledge.imported/updated/refreshed/deleted`, `template.created/updated/deleted`, `assistant.updated`, `assistant.tool_called`, `action.created/updated/deleted/tested/run`, `bot.taught`, `bot.gap_dismissed`, `reports.settings_changed`, `widget.settings_updated/domains_changed/key_rotated`, `email.settings_updated/test_sent`, `connector.updated`, `identity_secret.rotated`, `conversation.deleted`, `conversations.exported`, `contacts.exported`, `contact.merged`, `gdpr.data_read/exported/erased`, `tenant_backup.created/restored`, task deletion; since Phase 2 `booking.connected/settings_changed/disconnected/created/cancelled`, `channels.whatsapp_connected/whatsapp_updated/messenger_connected/messenger_updated/verify_token_rotated/disconnected/whatsapp_test_sent/template_sent`, `push.device_added/device_removed`, `mcp.server_created/server_updated/server_deleted/server_connected/tool_updated/tool_called`, `agency.enabled/disabled/updated/client_created/client_opened/client_removed/acted_as/branding_changed`, `billing.spend_cap_changed`. Read by admins for their company (`GET /api/admin/audit`, with an actor filter from `/audit/actors` and plain-English descriptions; `GET /audit/export` CSV), platform-level entries by superadmin only. Not audited: whole-database backup create/restore.
- **GDPR (`routes/gdpr.js`):** subject resolved by contact email / externalId / sessionId / contact id / legacy `userId`, tenant-scoped; 404 when nothing matches. `GET /export/:id` portable JSON (contacts + conversations with transcript, pre-chat metadata, email headers, rating, workflow answers, attachment names); `GET /user-data/:id` raw; `DELETE /user-data/:id` deletes uploaded files, anonymises task `contactInfo`, deletes matching webhook deliveries, bookings (by session, contact or email), conversations and contacts; all audited. Export and erase are on **People** (`client/admin/contacts.js`). The widget's consent checkbox sends `consent` with the visitor's first action and it is stored in the conversation's metadata; `POST /consent` (`{marketing, analytics, storage}`) still exists but the widget does not call it. `GET /privacy-policy` serves `public/privacy-policy.html` (the widget links the tenant's own policy, not this one). Anonymising a conversation also clears `followUp.email`, `handoff.summary` and `outcome.note`.
- **Retention (`services/dataRetention.js`, `Company.dataRetention`):** per-tenant `anonymizeAfterDays` and `deleteAfterDays` (0 = never, unset = platform default `RETENTION_ANONYMIZE_DAYS`/`RETENTION_DELETE_DAYS`, both default never); delete before anonymise refused; daily sweep deletes files then conversations, then anonymises (`Conversation.anonymize()` strips transcript, addresses, contact link, notes, workflow variables, rating comment; keeps timings/roles/scores); one tenant's failure does not stop the others; **Account → Data retention** shows what tonight's run would touch, recomputed as the numbers are typed (`GET /api/companies/me/retention/preview`), and asks for confirmation before a short delete window; changes audited. Only conversations are subject to retention.
- **Per-tenant backups (`services/tenant-backup.js`):** EJSON NDJSON per model under `backups/tenants/<companyId>/<timestamp>/` with a manifest listing counts and uncovered collections (`GoogleToken`, `StripeEvent`, and since October `RevokedToken`, whose rows expire with their eight-hour tokens); tenant-owned models discovered from schemas (so the new `TestCase`, `GapDismissal`, `KnowledgeCrawl`, `KnowledgeSource` and `AssistantProfile`, and Phase 2's `Booking`, `CalendarConnection`, `ChannelAccount`, `McpServer`, `PushSubscription` and `VisitorCode`, are covered; fields marked `select:false`, which include every stored credential and token hash, are exported too, so a restore does not strip them and the backup directory needs the database's protection), dependents (`Comment→Task`, `Notification→User`, `WorkflowVersion→Workflow`, `KnowledgeDocument→User`) declared; uploaded files not included; restore `merge` (upsert) or `replace` (requires typing the company name); a manifest for another company is refused; `AuditLog` and `RateLimitCounter` are exported but never restored. Nightly at 02:30 when `TENANT_BACKUPS_ENABLED`, retention `TENANT_BACKUP_RETENTION_DAYS` (90). Superadmin-only routes, audited, no UI.
- **Uploads (`services/uploads.js`, `routes/upload.js`):** MIME allowlist (client-declared, no sniffing/scanning), `MAX_UPLOAD_BYTES` (10 MB), random 32-hex ids under `uploads/<companyId>/`, downloads as `application/octet-stream` attachment with `nosniff` (raster images `?inline=1`), visitor (own session token) or staff of the owning company; plan feature `fileUploads`; metered. A visitor's first upload creates the conversation; operators upload through `POST /api/admin/conversations/:sessionId/files`. Deleting a conversation removes its files.
- **HTTP hardening (`server.js`):** helmet CSP (`script-src 'self'` and nothing else — the dashboard's libraries are bundled — no inline script, `script-src-attr 'none'`, `frame-ancestors 'self'`), compression, 1 MB body limit, MongoDB-backed session cookie (`httpOnly`, `secure` + `SameSite=None` in production), JSON 404 for `/api`, generic 500s in production, graceful shutdown. Production refuses to start without `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET` (≥32 chars, not defaults) and `OPENAI_API_KEY` (`config/env.js`).

### 2.10 Platform / ops

- **Superadmin tools:** **Platform → Companies** (list with plan, status, created via sign-up or superadmin, installed, last activity, `?q=` search; create a company with the first admin's email, required, who is sent an invitation — no generated address or password; edit; activate/deactivate, which disconnects its people; users CRUD; reset passwords); **Platform → Usage by tenant** (2.8); plan/overage/limit overrides; tenant pickers on Knowledge and Reports; `GET /api/workflow-execution/all-active`; backups via API only (`/api/operations/backups*` whole-database `mongodump`/`mongorestore --drop` when `BACKUPS_ENABLED`, `mongodb-tools` not in the image; `/api/operations/companies/:id/backups*` per-tenant); **Make agency / Stop agency** with a client limit on the company list (`PATCH /api/agency/companies/:id`). No superadmin impersonation (an agency's acting-as is 2.18). `DELETE /api/companies/:id` (only when the company has no users) first runs `uploads.purgeCompanyData`: its files, then every model with a `company` path found from the schemas (conversations, contacts, tasks with comments, workflows with versions, actions, webhooks and deliveries, chunks, usage, subscription, channel, calendar and MCP credentials, bookings, push devices, saved tests…), keeping users and the audit log; audited with the counts.
- **Health/metrics:** `GET /health` (liveness), `GET /ready` (503 while MongoDB is down), `GET /metrics` (Prometheus via `express-prom-bundle`: request-duration histogram, `chat_messages_total`, process metrics) guarded by `METRICS_TOKEN` (404 in production without one), `GET /api/operations/status` (memory/uptime; `admin` role), `GET /api/workflow-execution/health` (unauthenticated).
- **Alerting (`services/alerting.js`):** email only (`ALERTS_ENABLED`, `EMAIL_ALERTS_ENABLED`, `ALERT_RECIPIENTS`, every `ALERT_CHECK_INTERVAL` ms): `high_response_time` (avg > 2000 ms over the interval, warning) and `high_error_rate` (5xx > 5 %, critical) with resolution mails; memory/cpu/disk thresholds declared but unchecked.
- **Scheduler (`SCHEDULER_ENABLED`, default true; set on exactly one instance; `services/scheduler.js`, node-cron, server-local time):** webhook retries every minute; long-wait escalation every minute (`conversation-sweeps.escalateLongWaits`); booking reminders every 15 minutes (`booking.sendDueReminders`); idle close hourly at :05 (`closeIdleConversations`); knowledge due its weekly re-read hourly at :15 (`knowledgeCrawler.recrawlDue`, a few per run); usage warnings hourly at :45; resolutions counted at 01:15 (`resolutions.recordResolutions`) and reported to Stripe at 01:30 (`reportResolutionsToStripe`); task deadline sweep midnight + hourly 08–18; per-tenant backups 02:30; retention every 24 h; whole-DB backup every `BACKUP_INTERVAL_HOURS`; alert checks. Booking reminders, long-wait alerts, usage warnings and the Stripe report each claim their row atomically before sending, so an overlapping run does not send twice. Workflow run counts are flushed on shutdown. `REDIS_URL` switches socket.io to the Redis adapter for multi-instance. Logging: winston console + daily-rotated JSON files (`logs/`), `LOG_LEVEL`, query-string redaction of `secret|token|key|reset`.
- **Deployment:** `Dockerfile` (node:20-alpine, non-root, HEALTHCHECK), `docker-compose.yml` (app + mongo:7, optional `redis` profile, volumes for `uploads/` and `backups/`), CI (`.github/workflows/ci.yml`: lint, tests, `npm audit --audit-level=high`, image build). Tests: 114 `*.test.js` files (1,976 passing, 2 skipped without `php`) under `tests/` against in-memory MongoDB with `OPENAI_API_KEY` blanked; the Phase 2 suites are `tests/p2a-*` (booking) to `p2f-*` (agencies, resolutions), with Meta, Cal.com, Google, Calendly, Stripe and MCP servers stubbed.

### 2.11 Accounts: sign-up, invitations, sign-in and sessions (`routes/auth.js`, `middleware/auth.js`, `services/team.js`, `services/account-email.js`, `services/welcome-crawl.js`, `models/revoked-token.js`, `client/login.js`, `signup.js`, `invite.js`, `auth-common.js`)

- **Self-serve sign-up (`/admin/signup.html`, `POST /api/auth/signup`):** on unless `SIGNUP_ENABLED=false` (then 404). Email, password (≥8), company name, optional name and website. Creates the company (`createdVia:'signup'`; a name already taken becomes "Name 2" rather than revealing the other), its trial subscription at once, and a `company_admin` signed straight in; sends a confirmation email (`GET /api/auth/verify-email` sets `emailVerifiedAt`); reads the website into the knowledge base in the background (`welcome-crawl`). Until the address is confirmed the company can do everything except add allowed domains. Audited `company.signed_up`.
- **Account email (`services/account-email.js`):** confirmation, invitation and usage-warning mail through the platform's `SMTP_*`, with `PRODUCT_NAME` (default "Support Desk") in subjects and pages. Never throws; without SMTP, outside production, the link is written to the log.
- **Invitations (`services/team.js`):** `POST /api/admin/operators/invite {email, name?, role: operator|company_admin}` creates a user with `invitePending`, a hashed token and a seven-day expiry, and emails `/admin/invite.html?token=…`; when the email cannot go the response carries the link for the admin to pass on. Resend and withdraw (a withdrawn invitation's user is deleted). Accepting (`POST /api/auth/accept-invite`) sets the password, counts the address as confirmed and signs in. An invited operator holds a seat; an invited admin does not. Pending accounts cannot sign in (they are told to use the invitation) or connect a socket. A superadmin creating a company must give the first admin's address and the same invitation goes out.
- **Team screen:** operators and admins, active, deactivated and invited; role menus offer only operator/admin; "Remove" deactivates and anonymises (`deletedAt`) so history still points at the account, and withdraws a pending invitation outright. An admin can still create an account with a password they choose (`POST /api/admin/operators`).
- **Sign-in:** email or username; "show password"; `?next=` kept (only `/admin/` paths); Google sign-in (`GOOGLE_SIGNIN_CLIENT_ID/SECRET`, `/api/auth/google/start` → `/callback`, redirect URI `PUBLIC_URL/api/auth/google/callback`) for an existing, active account whose address Google has verified; the token comes back in the URL fragment. Nobody gets an account through Google.
- **Sessions:** see 2.9. "Sign out" ends this browser (revoked `jti`); "Sign out on every device" ends all. Deactivating a person bumps their token version, disconnects their sockets and returns their chats to the queue (`team.lockOut`).
- **Profile:** own name and timezone (`PUT /api/auth/me`), password change.

### 2.12 Knowledge base and the learning loop (`routes/knowledge.js`, `services/knowledge-*.js`, `models/knowledge-crawl.js`, `models/knowledge-source.js`, `routes/bot.js`, `routes/bot-persona.js`, `services/gaps.js`, `services/teach.js`, `services/test-cases.js`, `models/test-case.js`, `models/gap-dismissal.js`, `client/admin/knowledge.js`, `gaps.js`, `teach.js`, `bot-test.js`)

- **Ways in (Bot → Knowledge):** a whole site (`POST /api/knowledge/crawl {url, maxPages, refreshWeekly?}` → 202 with a job; `GET /crawl/:jobId` reports `{status, progress {phase, read, planned, saved, skipped}, imported, skipped, removed}`; one `KnowledgeCrawl` per site; a job whose heartbeat stopped is reported failed), a file (`POST /upload`, multipart `file`: PDF, text, Markdown, CSV, HTML, ≤ `KNOWLEDGE_UPLOAD_MAX_BYTES`), a page or PDF by URL, or pasted text (`POST /sources`). Every fetch goes through `safe-http.js`. A re-crawl replaces each page and drops the pages the site no longer has.
- **Keeping it current:** a site (`PATCH /crawl/:jobId {refreshWeekly}`) or a single page (`PATCH /sources/:sourceId {refreshWeekly}`) can be read again weekly; the scheduler takes a few due ones each hour (`recrawlDue`) and records `lastRefreshedAt` / `lastError` on `KnowledgeSource`. Pasted text keeps its original wording (`KnowledgeSource.text`) so it can be edited (`GET /sources/:sourceId/text`, `PUT /sources/:sourceId`); the new chunks are written before the old ones go.
- **The list:** sources with chunk counts and "Used in N answers" (counted from bot messages' `sources`); the Google Sheets card only with `GOOGLE_SHEETS_UI=true`.
- **Test your bot (`POST /api/bot/test`):** the real reply path without saving or counting anything (2.2); answers with `path`, `sources`, `knowledgeMatched`, `passages` (what retrieval found, with scores), `toolCalls`, `unanswered`, `failed` and, when the bot could not answer, `visitorWouldSee` (the hand-over line or the leave-a-message form, and why). `asVerified` runs the turn as a signed-in customer. Records `Company.onboarding.botTestedAt` at most daily (not for a superadmin).
- **Saved tests (`/api/bot/tests`, `TestCase`, ≤50 per company):** a question and what a good answer does — `contains` a text, `handover` (hands over or offers a person), or `cites` a source (any, or a named one). Run one, all (`POST /tests/run`), or automatically after every lesson taught; each keeps its `lastRun {passed, answer, path, reason, at}`.
- **Unanswered questions (Bot → Unanswered questions, `GET /api/bot/gaps?days=30&limit=50`):** occurrences are bot answers flagged unanswered or fallback, given a thumbs-down, or followed by a hand-over (the bot gave up, the model failed, or the visitor asked for a person within minutes); corrected ones are skipped. Grouped by overlapping words (no model), each group with counts by reason and examples. `POST /gaps/:key/dismiss` hides a group (`GapDismissal`) until it is asked again.
- **Teach the bot (`POST /api/bot/teach {question, answer, kind: knowledge|canned, title?, sessionId?, messageId?, gapKey?}`):** saves a knowledge note titled from the question, or a canned reply whose example is the visitor's own question; marks the message `correction {kind, refId, at, by}` (and, when taught from an operator's reply, the bot's failed attempt before it); closes the gap; re-runs the saved tests and returns their result. Reached from the unanswered list ("Add the answer"), from bot messages in a transcript, from Test your bot, and as "Save as the bot's answer" on an operator reply (admins). Audited `bot.taught`.
- **Persona & replies:** the guided builder, "Draft from my website" and the prompt in effect (2.2); canned replies with search and last used.

### 2.13 Booking (`routes/booking.js`, `services/booking/` (`index.js`, `providers/calcom.js`, `providers/google.js`, `providers/calendly.js`, `time.js`, `http.js`, `reminders.js`), `models/booking.js`, `models/calendar-connection.js`, `client/admin/booking.js`; **Bot → Booking**)

- **One calendar per company** (`CalendarConnection`, unique on `company`), behind one provider interface (`verify`, `listServices`, `slots`, `book`, `cancel`, `reschedule`). Credentials encrypted, `select:false`, never returned (`presentConnection`). All provider calls go through `safe-http`.
- **Cal.com:** an API key; `https://api.cal.com/v2` with the `cal-api-version` each endpoint expects, pinned (event types `2026-06-12`, slots `2024-09-04`, bookings `2026-02-25`). Cal.com owns event types, availability and confirmations. Cloud only.
- **Google Calendar:** OAuth (`POST /google/start` → Google → `GET /google/callback`), client `GOOGLE_CALENDAR_CLIENT_ID/SECRET` falling back to `GOOGLE_CLIENT_ID/SECRET`, redirect `GOOGLE_CALENDAR_REDIRECT_URI` or `PUBLIC_URL/api/booking/google/callback`, scopes `calendar.events` + `calendar.readonly`, `access_type=offline`, `prompt=consent`. The tenant defines services (name, duration 5–480 min, buffer 0–240), opening hours per weekday (default Mon–Fri 09:00–17:00), minimum notice (120 min), look-ahead (14 days, 1–60), calendar id (`primary`) and whether to invite the customer as a guest. Free times = hours − free/busy − buffers, in the business timezone, minus `businessHours.closedDates`; re-checked before booking. Disconnect revokes the token.
- **Calendly:** a personal access token. Paid plans book through the Scheduling API (`POST /invitees`); a free plan (403), an event type whose location the visitor must choose, or no email → a single-use pre-filled scheduling link, `status: 'link'`, stored as a `pending` booking with `url`. Reschedule books the new time, then cancels the old.
- **Timezone:** `Company.businessHours.timezone` (unless UTC), else the calendar account's, else UTC.
- **Dispatch:** `services/connector.js` hands `availability.slots`, `availability.book` and `availability.cancel` to `booking.dispatch` when the company has an enabled connection and the `actions` feature. Slots are cached 10 s; at most 25 per request and 5 services per search; a slot id encodes service and start. `book` refuses a service not enabled, a past time, one beyond the horizon, and a fourth upcoming booking in one conversation; the same session, service and start twice returns the first booking. References are `BK-` + six characters. A simulated (preview/test) write never reaches the provider. `cancel` needs the reference and either the same conversation or the booking's email.
- **Records and events:** `Booking` per appointment; `booking.created` (not for `pending`) and `booking.cancelled` webhooks and audit entries (the assistant as actor when the bot did it). Operators: `GET /bookings` (`?sessionId`, `?status`, `?upcoming=1`), `POST /bookings/:id/cancel`, `POST /bookings/:id/reschedule {start}` (a new booking with `rescheduledFrom`; the old becomes `rescheduled`).
- **Reminders (`reminders.js`, every 15 min):** one email about 24 h ahead per `booked` booking with an email, unless booked less than 12 h before or the connection has `reminders: false`; claimed atomically, up to 3 attempts; sent through the email channel's transport and sender (`EMAIL_HOST`, `EMAIL_FROM`); English only.
- **Elsewhere:** the "Book or change an appointment" template's `capability` node offers real slots when a calendar answers and takes its error branch to the task path otherwise; GDPR erasure deletes the person's bookings (`booking.erase`); `GET /api/companies/me/connector` reports the calendar's capabilities.

### 2.14 WhatsApp, Messenger and Instagram (`routes/channels.js`, `services/channels/` (`index.js`, `inbound.js`, `outbound.js`, `whatsapp.js`, `messenger.js`, `graph.js`, `text.js`), `models/channel-account.js`, `client/admin/channels-social.js`; **Channels → WhatsApp**, **Channels → Messenger & Instagram**)

- **Accounts:** `ChannelAccount` per provider per company (`whatsapp`, `messenger`, `instagram`; Instagram is saved from the Messenger form and reached with the Page's token). A phone number id, Page id or Instagram user id is unique across all tenants (partial unique indexes, also checked before saving → 409). Token and app secret encrypted; a blank field on save keeps the stored one. A random verify token per account, shared by Messenger and Instagram, rotatable. WhatsApp also stores an optional approved template `{name, language (en_US), param positional|named|none, paramName}`; Messenger the `humanAgentTag` switch. Status `pending → connected` on the first verified handshake or message, `error` with `lastError`, `disabled`.
- **Webhooks:** `GET /api/channels/webhook/:provider` answers `hub.challenge` (a strict pattern) only for a verify token this server issued, and records `webhookVerifiedAt`. `POST` is read raw (1 MB), checked against `X-Hub-Signature-256` with the matching account's app secret, then parsed; unknown ids and switched-off accounts are dropped; a company whose plan lacks `channels` gets the reason on its screen and the message is dropped. A failure while storing is a 500, so Meta retries; the provider's message id (`wamid…`, `mid…`) is stored on the message, so a repeat is ignored. Graph API `v26.0`, pinned (`graph.js`).
- **Inbound:** text, button and list replies, quick replies and postbacks; images and documents fetched (8 s) and stored like uploads when the plan has `fileUploads`, other media as a labelled placeholder; status updates (delivered, read, failed; a failure leaves a transcript line). A conversation per customer (`sessionId` `whatsapp-<hex>` etc., `external {provider, accountId, userId, lastInboundAt}`), metered like any other; name and phone from the profile. One customer's messages are stored one at a time per process. The bot's reply, a hand-over or a suggestion runs after the 200 through the same lifecycle as the widget (`services/conversation-lifecycle.js`); choices become WhatsApp reply buttons (up to three) or a list (up to ten rows), or Messenger quick replies.
- **Outbound:** operator messages and bot replies through the Graph API with read receipts; `windowFor(conversation, account)`: free text within 24 h of `lastInboundAt`; after that WhatsApp only the configured template (`POST /conversations/:sessionId/template`), Messenger/Instagram the `HUMAN_AGENT` tag up to 7 days if `humanAgentTag`; otherwise refused with the reason. No attachments to app customers, no typing indicator, no rating prompt; notices sent there are English.
- **Settings routes** (admin of the company, `apiLimiter`, `channels` feature for saves): `GET /settings` (accounts without secrets, `graphVersion`, callback URLs built from `PUBLIC_URL`), `PUT /whatsapp`, `PUT /messenger`, `POST /:provider/verify-token`, `DELETE /:provider`, `POST /whatsapp/test {to}`.

### 2.15 Visitor identity and email codes (`services/visitor-identity.js`, `services/visitor-verification.js`, `models/visitor-code.js`, `services/contacts.js`, `client/admin/identity.js`)

- **Signed proofs (`prove`)**, both with `Company.identitySecret`: a **JWT** — HS256 only; `exp` required, `nbf` honoured, 60 s skew; lifetime ≤ 24 h (from `iat`, or from now); `iat` not in the future; `sub` required (≤255); `aud`, when present, must equal the widget key; `email`, `name`; `attrs` (≤50 keys `[A-Za-z0-9_-]{1,64}`, values ≤500 chars, scalars stringified) stored as `Contact.signedAttributes`. Or the **HMAC** `HMAC-SHA256(secret, userId)` hex, constant-time. A token wins when both are sent. Failures leave the visitor anonymous, with a reason for logs; `expired` reaches the visitor as the `identity_expired` notice. Read from the socket handshake (`userJwt`, `externalId`, `userHash`; the widget reconnects when `identify` changes them), with the HMAC pair also accepted on `resume-session` and `user-details`, and re-checked on `visitor-identity`; the REST fallback takes the HMAC pair only. A resume presenting a different verified person than the conversation's is refused.
- **Email codes:** `verify-email-start {email, language?}` → a six-digit code (`crypto.randomInt`, stored salted and hashed in `VisitorCode`, one per session, TTL 10 min, 3 attempts) emailed in the visitor's language through the email channel's transport and sender; limits counted in MongoDB: 3 per session per 10 min, 5 per address per hour, `VERIFY_EMAIL_HOURLY_LIMIT` (200) per company per hour. `verify-email-code {code}` → the contact becomes `verified`, `verifiedBy: 'email_code'`. Without `EMAIL_HOST`/`EMAIL_FROM` the reason is `unavailable`.
- **The rule (`isVerifiedEnough(contact, requirement)`):** `signed` (the default) is met only by `jwt`/`hmac` (or an older verified contact with an externalId); `email` also by `email_code`. Actions state theirs as `Action.verification` (`signed|email`, "Email verification is enough" in the editor), enforced in `services/actions.js#resolveInputs` and in what the assistant is offered. MCP tools' "verified customers only" always means `signed`. When proving an email would unlock an enabled action, the assistant gets `verify_visitor_email`, which answers with a "Verify with your email" choice (`action: 'verify_email'`). `askVisitor(sessionId)` (emits `verify-email-request`) exists for an operator or flow but has no caller.
- **Identity screen:** the secret, JWT examples (Node `jsonwebtoken`, Python `pyjwt`, PHP `firebase/php-jwt`, Ruby `jwt`) with the company's widget key as `aud` and one-hour expiry, the `data-user-jwt` snippet, the `identity-expired` refresh snippet, and the HMAC examples (`GET /api/contacts/identity/secret` still returns the HMAC one-liners).

### 2.16 MCP connected tools (`services/mcp-client.js`, `routes/mcp.js`, `models/mcp-server.js`, `services/assistant-tools.js`, `client/admin/mcp.js`; **Bot → Actions → Connected tools (MCP)**)

- **Servers:** up to 10 per company; name, URL (https; http only for localhost outside production; no credentials in the URL; address-checked), auth `none|bearer|header` (`headerName`), secret encrypted and never returned (`hasSecret`); a saved secret is sent only to the origin it was saved for, so changing the URL means typing it again; a unique `slug` (≤20 chars) names its tools. Status `new|connected|error`, `protocol {era modern|legacy, version}`, `serverInfo`, `warnings`.
- **Client:** Streamable HTTP only, tools only (no resources, prompts, sampling or elicitation; declares no capabilities). Modern era first (`2026-07-28`: `server/discover`, `_meta`, `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers), then the legacy `initialize` handshake (`2025-11-25`, `2025-06-18`, `2025-03-26`) with `Mcp-Session-Id`; JSON or SSE responses; `tools/list` paging (≤10 pages, ≤200 tools); 15 s deadline (8 s probe); 1 MB response cap; every request through `safe-http`. OAuth servers are not supported.
- **Tools:** `POST /:id/connect` merges a fresh list: new tools arrive **off**, automatic, not verified-only, ask-before-running unless `readOnlyHint`; a changed description or schema sets `changedAt`; a tool that loses `readOnlyHint` gets confirmation back; a tool no longer listed is kept, `available: false`. `PUT /:id/tools/:tool {enabled, mode automatic|workflow_only, verifiedOnly, needsConfirmation}`; switching one on checks the shared `actions` limit and that its schema can be offered to a model.
- **Assistant:** enabled automatic tools (≤32) as `mcp_<slug>_<tool>` (≤64 chars, hashed when longer or taken) with sanitised schemas; verified-only ones only to signed visitors; a tool not read-only counts as the turn's one write, asks first when `needsConfirmation`, and never runs in a simulated turn; arguments ≤16 KB; results fenced and capped at 4 KB; `lastCalledAt`; audit `mcp.tool_called` (tool, outcome, duration, argument names; no values). Workflows cannot call MCP tools. `mcp_` is reserved in Action names.

### 2.17 The operator app and push (`public/admin/sw.js`, `public/admin/offline.html`, `public/admin/icons/`, `routes/push.js`, `services/push.js`, `models/push-subscription.js`, `client/admin/push.js`, `scripts/generate-vapid-keys.js`, `scripts/generate-app-icons.js`; **My settings → Notifications on this device**)

- **Installable:** `GET /admin/manifest.webmanifest` (name and short name from `PRODUCT_NAME`, `start_url /admin/?section=active-chats`, scope `/admin/`, standalone, icons any + maskable); the service worker is served with `Service-Worker-Allowed: /admin/` and `no-cache`, pre-caches only `/dist/admin.js`, `/dist/admin.css`, the offline page and one icon, and never intercepts `/api` or serves the dashboard page from cache. "Install the app" in the profile menu (once offered), iOS steps shown for Safari.
- **Push:** Web Push with VAPID (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` mailto:/https:), sent with the `web-push` library loaded on first use. `PushSubscription` per browser: `level all|important|none`, `previews` (off by default), the session's `jti` and `tokenVersion` (a signed-out session's devices are pruned), `vapidKey` (a device subscribed under an old key is asked to resubscribe). Conversation events (new chat, hand-over) go to operators taking chats in the company, respecting each device's level and only within business hours, TTL 1 h; `notifyUser` kinds (assigned, transferred, waiting, task assigned, low rating, usage warning) to the person, TTL 24 h. A device the push service says is gone is deleted. Sending never throws. The dashboard's own desktop alert stands down in a browser where push is on.
- **Routes** (`/api/push`, operator, own devices only): `GET /key`, `GET /devices`, `POST /subscribe` (register, change settings, or `refresh` on load; audited `push.device_added` when new), `DELETE /subscribe` (`endpoint` or `id`), `POST /test` (503 `PUSH_NOT_CONFIGURED` without keys).

### 2.18 Agencies, white-label and per-resolution pricing (`routes/agency.js`, `services/agency.js`, `middleware/auth.js`, `services/resolutions.js`, `routes/billing.js`, `client/admin/agency.js`; **Clients**, **Platform → Companies**, **Account → Plan & billing**)

- **Agencies:** `Company.agency {isAgency, parent, clientLimit, attachedAt, detachedFrom, detachedAt}`, set only by a superadmin (`PATCH /api/agency/companies/:id {isAgency, clientLimit}`; a client of another agency cannot become one). `GET /api/agency/me` (terms, client count, extra clients and their cost, brand, whether branding is allowed), `GET /clients` (each client's plan, status, installed, conversations, resolution rate, last activity), `POST /clients {name, website?, adminEmail, adminName?, plan: trial|<client plan>}` (refused unless the agency's own subscription is entitled, under the client limit, name and email unused; the paid client plan needs the agency itself on an active, paid Agency plan, else 402 `AGENCY_NOT_PAYING`, and is applied `active` with `managedByAgency`; the admin invited under the agency's brand), `POST /clients/:id/open` (the one-hour acting token, 2.9), `DELETE /clients/:id` (detach; an agency-paid plan reverts to a fresh trial), `PUT /branding`. All agency routes need a `company_admin` of an agency not currently acting as a client.
- **White-label:** `Company.branding {productName ≤60, logoUrl https, primaryColor #rrggbb, supportEmail}`, in force when the owner is an active agency with a product name on a plan with `customBranding`; applies to the agency and its clients. `services/agency.js#effectiveBranding` feeds `GET /api/auth/config?invite=|?company=` (sign-in and invitation pages; a branded page offers no sign-up), `GET /api/auth/verify` (the dashboard) and `services/account-email.js` (platform emails). The widget carries no product brand, so it is unchanged.
- **Resolutions (`services/resolutions.js`):** the value report's `resolvedPipeline`, imported; a conversation counts once `ended` or idle 24 h (`SETTLE_MS`), in the UTC month it started. `bill()` works in cents: included resolutions off, then the cap in whole resolutions (`floor(cap / price)`), giving `billable`, `unbilled`, `amount`, `capReached`, `capPercent`. Nightly at 01:15 `recordResolutions` stores each company's count (`Usage.resolutions`); at 01:30 `reportResolutionsToStripe` sends each per-resolution tenant with a Stripe customer one meter event per day for the difference between billable and already reported (which can be negative after the cap is lowered), retrying an unanswered one unchanged first and dropping one older than Stripe's 35 days; the previous month stays open for three days. The live count is cached 60 s for the banner.
- **Spend cap:** `PUT /api/billing/me/spend-cap {cap: number|null}` (admin, per-resolution plans only, not while acting; audited `billing.spend_cap_changed`; clears the cap's 80%/100% warning claims).

### 2.19 The WordPress plugin and Shopify snippet (`sdk/wordpress-plugin/support-desk-chat/`, `sdk/shopify/`, `routes/downloads.js`, `services/install-packages.js`)

- **Downloads** (public, `Cache-Control: private, no-store`): `GET /api/downloads/wordpress/support-desk-chat.zip?key=` and `GET /api/downloads/shopify/support-desk-chat.liquid?key=[&download]`; a key belonging to a company gets a copy with it and the server address (`PUBLIC_URL` or the request host) filled in, anything else the plain copy. Linked from **Channels → Website widget**'s WordPress and Shopify tabs, which also show the Shopify snippet inline.
- **WordPress plugin** (PHP ≥7.4, WP ≥5.8): **Settings → Support Desk Chat** (https server address, widget key, show switch, paths to hide on, identity secret or `SUPPORT_DESK_CHAT_IDENTITY_SECRET` in `wp-config.php`, "Logged-in users"); prints the loader tag with a one-hour HS256 token (`sub` user id, email, display name, `aud` widget key) for logged-in users and refreshes it through `admin-ajax` on `identity-expired`; filters `support_desk_chat_identity_claims`, `support_desk_chat_token_ttl` (≤ a day), `support_desk_chat_show`; `uninstall.php` removes its options on every site of a network. Not on WordPress.org.
- **Shopify snippet:** `sdc_server_url`, `sdc_widget_key`, `sdc_identity` (`none` default, `app_proxy` fetching `{jwt}` from `sdc_token_path` (`/apps/support-desk/token`) and again on expiry, or `metafield` reading `support_desk.user_hash`), with a README walking through the App Proxy (Node example) and the metafield. Not a Shopify app.

---

## 3. API reference summary

Auth legend: **public**; **visitor** (session cookie / `sessionId`+`sessionToken`); **operator** (= operator, company_admin, superadmin); **admin** (= company_admin, superadmin); **admin-own** (admin with a company); **superadmin**; **api-key**; **webhook** (signature/secret); **auth** (any signed-in role). Middleware in `middleware/auth.js` (`auth`, `operator`, `admin`, `superadmin`, `domainsNeedVerifiedEmail`), `middleware/quota.js`, `middleware/api-key.js`. `auth` also refuses revoked tokens, pending invitations and deactivated companies.

Mounts (`server.js`): `express.raw` on `/api/channels/webhook` ahead of the JSON parser; `/api/v1` public-api (own limiter) and `/api/channels` (signed webhooks; its settings routes apply the API limiter themselves) mounted before the general limiter; limiters on `/api/auth/login`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/chat`, then `/api` (general); routes: chat, admin, auth, gdpr, operations, google, tasks, companies, workflows, webhooks, workflow-execution, notifications, widget, upload, billing, templates, knowledge, bot (with bot-persona inside), contacts, email, api-keys, actions, push, agency, mcp, booking, downloads. Inline: `GET /health`, `GET /ready`, `GET /metrics`, `GET /admin/manifest.webmanifest`, `GET /` → `/admin/`, hashed widget assets, static `public/` (including `/admin/login.html`, `/admin/signup.html`, `/admin/invite.html`, `/admin/sw.js` with `Service-Worker-Allowed: /admin/`).

### `routes/auth.js` — `/api/auth`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | public | `{productName, branding, signupEnabled, googleSignIn, publicUrl}` for the sign-in pages; `?invite=<token>` or `?company=<id>` returns an agency's brand when one applies (and then no sign-up) |
| POST | `/login` | public (rate-limited) | Email or username → 8 h JWT; pending invitation, disabled account and deactivated company refused with a reason; every outcome audited |
| POST | `/logout` | auth | Revoke this token's `jti`; `{everywhere:true}` ends all sessions |
| POST | `/logout-everywhere` | auth | Bump `tokenVersion`, disconnect sockets |
| POST | `/change-password` | auth | Requires current password; returns a new token, other sessions end |
| PUT | `/me` | auth | Own display name and timezone |
| POST | `/forgot-password` | public (rate-limited) | Always 200; emails reset link via `SMTP_*` |
| GET | `/reset-info` | public (rate-limited) | Whether a reset link is live; minimum password length |
| POST | `/reset-password` | public (rate-limited) | Consume token |
| POST | `/signup` | public (5/h per address); 404 when `SIGNUP_ENABLED=false` | `{email, password, companyName, name?, website?}` → company + trial + admin + token; confirmation email; background crawl; 409 `EMAIL_TAKEN` |
| GET | `/verify-email?token=` | public (rate-limited) | Confirm the address; redirect to `/admin/?verified=<outcome>` (`?format=json` for JSON) |
| POST | `/resend-verification` | auth (5/h) | Send the confirmation again |
| GET | `/invite/:token` | public (rate-limited) | Who a live invitation is for (email, name, role, company, inviter, minimum length) |
| POST | `/accept-invite` | public (rate-limited) | `{token, password, displayName?}` → set password, address confirmed, token |
| GET | `/google/start` | public (404 unconfigured) | Redirect to Google, state signed and bound to a cookie |
| GET | `/google/callback` | google-oauth | Existing active account with that verified address → `/admin/login.html#token=…`; otherwise back with a reason |
| POST | `/register` | admin + `enforceLimit('operators')` | Older create-user route (the dashboard uses `/api/admin/operators*`) |
| POST | `/create-superadmin` | public while no users exist | Bootstrap |
| GET | `/verify` | auth | Validate token, return user (`emailVerified`, `verificationRequired`, company `createdVia`, `isAgency`, `actingAs` while working in a client) and the dashboard's `branding` |

### `routes/admin.js` — `/api/admin` (all `auth`+`operator`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/active-chats` | operator | Queue (≤200): real counts, preview, wait, reason, holder; empty legacy rows excluded |
| GET | `/chat-history` | operator | Paginated history: `search` (name, email, tag), `from`, `to`, `channel`, `status`, `handledBy`, `rating`, `outcome`, `tag` |
| GET | `/chat/:sessionId` | operator | Full conversation |
| POST | `/chat/:sessionId/contact-info` | operator | Set name/email/phone; updates the Contact |
| PUT | `/chat/:sessionId/tags` | operator | Replace tags; webhook `conversation.tagged` |
| GET | `/tags` | operator | Known tags |
| GET/PUT | `/me/availability` | operator | `acceptingChats`, `maxConcurrentChats` |
| POST | `/chat/:sessionId/claim` | operator | Atomic claim (409 if held) |
| POST | `/conversations/:sessionId/files` | operator | Send the visitor a file |
| POST | `/chat/:sessionId/notes` | operator | Add internal note |
| DELETE | `/chat/:sessionId/notes/:noteId` | operator (author or admin) | Delete note (broadcast) |
| GET | `/chat/:sessionId/transfer-targets` | operator | Operators and admins with presence |
| POST | `/chat/:sessionId/transfer` | operator (holder, or admin) | Transfer with note; 409 if the target is offline or not taking chats |
| DELETE | `/chat/:sessionId` | admin | Delete conversation and its files (audited) |
| POST | `/chat/:sessionId/end` | operator (holder, or admin) | End with `{outcome: resolved\|follow_up\|unresolved\|spam, note}`; CSAT; webhook |
| POST | `/chat/:sessionId/follow-up` | operator | Answer by email (visitor gone or chat ended) |
| GET | `/analytics` | operator | Basic report (`days`, `companyId` for superadmin) |
| GET | `/analytics/advanced` | operator, plan advanced | Advanced report (`days`) |
| GET | `/analytics/value`, `/analytics/value/export` | operator | Value report; CSV |
| PUT | `/analytics/settings` | admin | `minutesPerConversation` (audited) |
| GET | `/export` | admin | History CSV with the same filters (audited, formula-safe) |
| GET | `/audit`, `/audit/actions`, `/audit/actors`, `/audit/export` | admin | Audit search, distinct actions and actors, CSV |
| GET | `/operators` | operator | Operators for task assignment |
| GET | `/all-operators` | admin | The team screen: active, deactivated, invited |
| GET | `/operators/online` | admin | Who is connected and taking chats (Home) |
| POST | `/operators/invite` | admin (seat checked for operators) | Invite an operator or admin |
| POST | `/operators/:id/resend-invite` | admin | Resend (link returned when the email cannot go) |
| DELETE | `/operators/:id/invite` | admin | Withdraw an invitation (deletes the pending user) |
| POST | `/operators` | admin (seat checked for operators) | Create an account with a chosen password |
| PATCH | `/operators/:id` | admin | Toggle `isActive` (seat re-check; deactivation locks out) |
| PUT | `/operators/:id` | admin | Update allow-listed fields and role (audited) |
| DELETE | `/operators/:id` | admin | Remove: deactivate and anonymise |
| POST | `/operators/:id/reset-password` | admin | Set password, bump tokenVersion |

### `routes/chat.js` — `/api/chat`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/history` | visitor | Messages for session |
| POST | `/message` | visitor | REST fallback: creates the conversation on the first message (quota), resolves the contact, workflow/assistant reply, hands over instead of apologising |

### `routes/widget.js` — `/api/widget`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | public | Tenant presentation settings, availability, features, hashed asset paths; records `widgetSeen` |

### `routes/upload.js` — `/api/upload`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | visitor (session + token) | Upload one file (plan `fileUploads`); creates the conversation if it is the visitor's first action |
| GET | `/:fileId` | visitor (own session) or staff of owning company | Download (`?inline=1` for raster images) |

### `routes/company.js` — `/api/companies` (all `auth`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | superadmin | Companies with plan, status, created via, installed, last activity; `?q=` |
| GET/PUT | `/me/widget` | admin-own | Widget key, allowed domains (409 `DOMAIN_TAKEN`; 403 `EMAIL_NOT_VERIFIED` for an unconfirmed self-signed-up company), `widgetSettings`, `widgetSeen` |
| POST | `/me/widget/check` | admin-own | "Check my site": fetch a page, look for the snippet |
| POST | `/me/widget/rotate-key` | admin-own | Rotate widget key (audited) |
| GET | `/me/setup` | admin (superadmin names `companyId`) | Checklist data |
| GET/PUT | `/me/hours` | admin-own | Business hours, overnight ranges, `closedDates` (audited) |
| GET/PUT | `/me/retention`; GET `/me/retention/preview` | admin-own | Retention policy (audited); what a policy would touch tonight |
| GET | `/me/connector/sdk` | admin-own | SDK package name, version, guide |
| GET/PUT | `/me/connector` | admin-own | Connector URL/enabled/secret (enable needs a successful check) |
| POST | `/me/connector/check` | admin-own | Discovery |
| GET/PUT | `/me/routing` | admin-own | autoAssign / assignOnStart / maxConcurrent / escalateAfterMinutes (0–240, default 5) (audited) |
| GET/PUT | `/me/email` | admin-own | Email channel settings, inbound URL, `lastInboundAt`, sender preview |
| POST | `/me/email/test` | admin-own | Send a test email to the signed-in admin |
| GET | `/:id` | superadmin or own company | Company |
| POST | `/` | superadmin | Create company; `adminEmail` required; invites the first admin |
| PUT | `/:id` | superadmin or that company's admin | Update (`isActive` superadmin only; deactivating disconnects its people) |
| DELETE | `/:id` | superadmin | Delete if no users, purging every company-scoped collection and its files first (audited with counts) |
| GET | `/:id/users` | superadmin or own company | Users |
| GET/PUT | `/:id/admin` | superadmin | Company admin |
| POST | `/:id/admin/reset-password` | superadmin | Reset |
| POST | `/:id/users` | superadmin + seat quota | Create user |
| GET/PUT | `/:id/users/:userId` | superadmin | User |
| POST | `/:id/users/:userId/reset-password` | superadmin | Reset |
| PATCH | `/:id/users/:userId/status` | superadmin | Set `isActive` (deactivation locks out) |

### `routes/contacts.js` — `/api/contacts` (`auth`+`operator`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | operator | Search/list (`search`, `tag`, `verified`, paging) |
| GET | `/tags` | operator | Tags in use on contacts |
| GET | `/export` | admin | CSV with the list's filters (audited, formula-safe) |
| GET | `/:id` | operator | Contact + conversations + timeline |
| PUT | `/:id` | operator | Edit name/email/phone/tags/attributes |
| POST | `/:id/merge` | operator | Merge `sourceId` into `:id` (audited) |
| GET | `/identity/secret` | admin-own | Identity HMAC secret + examples |
| POST | `/identity/secret/rotate` | admin-own | Rotate (audited) |

### `routes/task.js` — `/api/tasks` (`auth`+`operator`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/assignees` | Active operators and admins of the company |
| GET | `/` | List/filter/search, paging |
| GET/PUT/DELETE | `/:id` | Read/update/delete |
| POST | `/` | Create (webhook `task.created`) |
| POST | `/:id/assign` | Assign (same company only; notifies) |
| GET/POST | `/:id/comments` | Comments |
| PUT/DELETE | `/:id/comments/:commentId` | Edit/delete own comment |
| GET/POST | `/:id/follow-ups` | Follow-up tasks |
| GET | `/:id/activities` | Activity log |

### `routes/notification.js` — `/api/notifications`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | operator | Own notifications (paged) |
| PUT | `/:id/read`, `/read-all` | operator | Mark read |
| DELETE | `/:id` | operator | Delete |
| POST | `/check-deadlines` | admin | Run deadline sweep |

### `routes/templates.js` — `/api/templates` (canned replies + persona)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/mine` | operator | Enabled templates for the composer |
| GET/POST | `/` | admin | List / create (audited) |
| PUT/DELETE | `/:id` | admin | Update / delete (audited) |
| POST | `/preview` | admin | Semantic match test (not counted as use) |
| GET/PUT | `/assistant/config` | admin | Persona, scope, the guided builder's answers, which source is in effect |

### `routes/bot.js` (+ `routes/bot-persona.js`) — `/api/bot` (all `auth`+`admin`; superadmin names `companyId`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/test` | Test your bot (2.12) |
| GET | `/gaps` | Unanswered questions, grouped (`days`, `limit`) |
| POST | `/gaps/:key/dismiss` | Dismiss a group (audited) |
| POST | `/teach` | Teach the bot (audited); re-runs saved tests |
| GET/POST | `/tests` | List / save a test (≤50) |
| POST | `/tests/run` | Run all, or `{ids}` |
| PUT/DELETE | `/tests/:id` | Edit / delete |
| POST | `/tests/:id/run` | Run one |
| GET | `/prompt-preview` | The system prompt in effect, part by part (`?message=` picks the strategy) |
| POST | `/persona-draft` | Draft a persona from the tenant's knowledge (409 `NO_MODEL` without a key); saves nothing |

### `routes/actions.js` — `/api/actions` (all `auth`+`admin`+feature `actions`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/presets` | The five service recipes as action templates |
| GET | `/`, `/:id` | List / one (credential shown only as `hasCredential`) |
| POST | `/` (+ `actions` limit) | Create (audited) |
| PUT | `/:id` | Update (audited) |
| DELETE | `/:id` | Delete (audited) |
| POST | `/test` | Run an unsaved definition once ("Run once" on the form as it stands) |
| POST | `/:id/test` | Run a saved action once |
| GET | `/:id/runs` | Last 20 runs (assistant, workflow, Run once) and the last error, from the audit log |

### `routes/knowledge.js` — `/api/knowledge` (all `auth`+`admin`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | admin | Stats, sources with "used in N answers", crawl sites, `features.googleSheets` (`companyId` for superadmin) |
| POST | `/sources` | + `knowledgeBase` + chunk quota | Import `{url}` (page/PDF) or `{text,title}` |
| GET | `/sources/:sourceId/text` | admin | A pasted note's text, for editing |
| PUT | `/sources/:sourceId` | + `knowledgeBase` | Replace a pasted note's text (new chunks written before the old go) |
| PATCH | `/sources/:sourceId` | admin | Per-source settings (`refreshWeekly`) |
| POST | `/upload` | + `knowledgeBase` + chunk quota | Upload a file (multipart `file`, `title?`) |
| POST | `/crawl` | + `knowledgeBase` + chunk quota | Start a background crawl → 202 `{jobId}` |
| GET | `/crawl/:jobId` | admin | Crawl progress and result |
| PATCH | `/crawl/:jobId` | admin | Site settings (`refreshWeekly`) |
| POST | `/sources/:sourceId/refresh` | + `knowledgeBase` | Re-fetch a url/pdf source in place |
| POST | `/search` | admin | Vector search test |
| DELETE | `/sources/:sourceId` | admin | Remove source |

### `routes/google.js` — `/api/google` (Sheets import; card hidden unless `GOOGLE_SHEETS_UI=true`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/url` | auth | OAuth URL (503 if unconfigured) |
| GET | `/oauth2callback` | google-oauth (signed state) | Token exchange |
| GET | `/status` | auth | `{authorized, email, configured}` |
| GET | `/drive/search` | auth | Spreadsheets in Drive |
| POST | `/knowledge/import` | auth | Import sheet → `KnowledgeDocument` |
| GET | `/knowledge`, `/knowledge/:id` | auth | List / get |
| POST | `/knowledge/:id/refresh`, `/knowledge/:id/columns` | auth | Refresh / excluded columns |
| DELETE | `/knowledge/:id` | auth | Delete |
| GET | `/sheets/:spreadsheetId/names`, `/sheets/:spreadsheetId` | operator | Sheet names / data |

### `routes/workflow.js` — `/api/workflows` (`auth` + superadmin/company_admin)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List (`status`) with live/draft versions, trigger, run stats, live-workflow allowance |
| GET | `/templates`, `/templates/:id` | Workflow templates (with triggers) |
| GET | `/:id` | One (credentials redacted) |
| POST | `/` (+ `workflows` feature) | Create a draft (not metered) |
| POST | `/:id/duplicate` (+ `workflows` feature) | Copy as a draft (audited) |
| PUT | `/:id` | Update; on a live workflow this makes a draft version visitors do not see; returns `{ready, warnings, problems}` |
| POST | `/:id/publish` | Validate, make live, hot swap; `{replace:true}` to replace the live `always` workflow (else 409); live-workflow limit checked here (audited) |
| POST | `/:id/unpublish` | Back to draft (audited) |
| POST | `/:id/archive` | Archive |
| GET | `/:id/versions` | Version history |
| POST | `/:id/rollback/:version` | Rollback (audited) |
| DELETE | `/:id` | Delete draft/archived (audited) |
| GET | `/active/current` (any auth role) | Active workflow |
| POST | `/validate` | Validate graph |
| POST | `/actions/test` | Run one action node |
| POST | `/preview` | Simulate a graph (with history) |
| GET | `/:id/stats` | Persisted `executionStats` |

### `routes/workflow-execution.js` — `/api/workflow-execution`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/execute` | admin | Run tenant's published workflow |
| GET | `/status` | admin | Runtime status |
| GET | `/all-active` | superadmin | All loaded workflows |
| POST | `/reload` | admin | Force-load a workflow |
| GET | `/health` | public | Runtime health |

### `routes/webhooks.js` — `/api/webhooks` (`auth`+`admin`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/events` | Event catalogue |
| GET | `/deliveries` | Delivery log |
| GET/POST | `/` | List / create (secret shown once) |
| PUT | `/:id` | Update/enable |
| POST | `/:id/rotate-secret` | Rotate |
| POST | `/:id/test` | Send test (also to a disabled endpoint) |
| POST | `/:id/deliveries/:deliveryId/redeliver` | Send a failed delivery again (audited) |
| DELETE | `/:id` | Delete |

### `routes/billing.js` — `/api/billing`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/plans` | public | Catalogue |
| GET | `/me`, `/me/history` | admin | Own plan, usage, checkout availability; 12-month history |
| GET | `/me/status` | admin | Banner data: trial state, meters at or past 80%, whether Developers is offered |
| GET | `/invoices` | admin | The tenant's invoices from Stripe |
| POST | `/checkout` | admin, not while acting | Stripe Checkout Session for `{plan, pricing?: 'per_resolution'}` → `{url}` (audited); `agency` only for an agency |
| POST | `/portal` | admin, not while acting | Stripe Billing Portal → `{url}` |
| PUT | `/me/spend-cap` | admin, not while acting | `{cap: number\|null}` for a per-resolution plan (audited `billing.spend_cap_changed`) |
| PATCH | `/companies/:companyId/subscription` | superadmin | Change plan/overage/overrides |
| POST | `/webhook/stripe` | webhook (Stripe signature) | Apply Stripe events |
| GET | `/companies/:companyId`, `/usage` | superadmin | Tenant summary / every tenant's usage (`?period=`) |

### `routes/api-keys.js` — `/api/api-keys` (admin-own)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List + scopes + `enabled` |
| POST | `/` (plan `apiAccess`) | Create (key shown once; optional expiry) |
| DELETE | `/:id` | Revoke |

### `routes/public-api.js` — `/api/v1` (api-key)
| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Key info |
| GET | `/conversations`, `/conversations/:sessionId` | scope `conversations:read` |
| GET | `/contacts` | scope `contacts:read` |
| GET | `/tasks` | scope `tasks:read` |

### `routes/email.js` — `/api/email`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/inbound/:companyId/:provider?` | webhook (`X-Inbound-Secret`, or `?secret=`/body) | Inbound mail → conversation |

### `routes/gdpr.js` — `/api/gdpr`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/user-data/:userId` | admin | Raw subject data (audited) |
| DELETE | `/user-data/:userId` | admin | Erase (audited) |
| GET | `/export/:userId` | admin | Portable export (audited) |
| GET | `/privacy-policy` | public | Static page |
| POST | `/consent` | visitor | Store consent (the widget sends consent on the socket instead) |

### `routes/operations.js` — `/api/operations`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/status` | admin | Process status |
| GET/POST | `/backups`, `/backups/create`, `/backups/restore` | superadmin | Whole-DB backups (not audited) |
| GET/POST | `/companies/:companyId/backups`, `…/backups/:timestamp/restore` | superadmin | Per-tenant backups (audited) |

### `routes/booking.js` — `/api/booking` (superadmin names `companyId`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/google/callback` | google-oauth (signed state + nonce cookie) | Finish connecting Google Calendar; redirects to `/admin/?section=booking` with `connected` or `booking_error` (audited `booking.connected`) |
| GET | `/bookings` | operator | Bookings (`sessionId`, `status`, `upcoming`, `limit`) |
| POST | `/bookings/:id/cancel` | operator | Cancel in the provider and here (webhook `booking.cancelled`) |
| POST | `/bookings/:id/reschedule` | operator | `{start}` → a new booking; the old one `rescheduled` |
| GET | `/connection` | admin + `actions` | The connection without credentials, and which providers this server offers (`google.available`, `redirectUri`) |
| POST | `/connect` | admin + `actions` | `{provider: calcom\|calendly, key}` → verify, list event types, save (audited) |
| POST | `/google/start` | admin + `actions` | Google's consent URL, bound to this browser by a nonce cookie (503 without a client) |
| PUT | `/connection` | admin + `actions` | `enabled`, `services`, `hours`, `minNoticeMinutes`, `horizonDays`, `calendarId`, `inviteAttendee`, `reminders` (audited) |
| POST | `/connection/refresh` | admin + `actions` | Fetch event types again |
| POST | `/test` | admin + `actions` | The next three free slots; books nothing |
| DELETE | `/connection` | admin + `actions` | Disconnect (Google token revoked; audited) |

### `routes/channels.js` — `/api/channels`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/webhook/:provider` | public (verify token) | Meta's handshake for `whatsapp`, `messenger`, `instagram` |
| POST | `/webhook/:provider` | webhook (`X-Hub-Signature-256`) | Messages and statuses; raw body |
| GET | `/settings` | admin-own | All three accounts (no secrets), callback URLs, Graph version, whether the plan allows them |
| PUT | `/whatsapp` | admin-own + `channels` | Connect or change the number, token, app secret, template (409 if another company has the number; audited) |
| PUT | `/messenger` | admin-own + `channels` | Page, optional Instagram account, token, app secret, Human Agent switch (audited) |
| POST | `/whatsapp/verify-token`, `/messenger/verify-token` | admin-own | New verify token (audited) |
| DELETE | `/whatsapp`, `/messenger` | admin-own | Disconnect and forget credentials (audited) |
| POST | `/whatsapp/test` | admin-own + `channels` | `{to}` test message (audited) |
| GET | `/conversations/:sessionId/window` | auth, same company | What the composer may send now and until when |
| POST | `/conversations/:sessionId/template` | auth, same company | Send the approved WhatsApp template (audited) |

### `routes/push.js` — `/api/push` (all `auth`+`operator`; the caller's own devices)
| Method | Path | Purpose |
|---|---|---|
| GET | `/key` | `{enabled, publicKey}` |
| GET | `/devices` | This person's devices |
| POST | `/subscribe` | `{subscription, applicationServerKey?, level?, previews?, installed?, refresh?}` → register or update (201 when new; audited) or `{resubscribe, publicKey}` |
| DELETE | `/subscribe` | `{endpoint}` or `{id}` (audited for `id`) |
| POST | `/test` | Test notification to all, or `{id}` (503 `PUSH_NOT_CONFIGURED`, 404 when no device answers) |

Also `GET /admin/manifest.webmanifest` (public), served from the same file.

### `routes/mcp.js` — `/api/mcp` (all `auth`+`admin`+feature `actions`; superadmin names `companyId`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Servers with their tools (no secrets) |
| POST | `/` | Add a server (≤10; audited) |
| PUT | `/:id` | Change name, URL, auth; a new address or credential resets the connection (audited) |
| DELETE | `/:id` | Remove (audited) |
| POST | `/:id/connect` | Discover the protocol and list tools; merges with saved switches (audited, success or failure) |
| PUT | `/:id/tools/:tool` | `enabled`, `mode`, `verifiedOnly`, `needsConfirmation`; switching on checks the shared actions limit (402) (audited) |

### `routes/agency.js` — `/api/agency` (all `auth`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/me` | agency admin, not acting | Terms, client count, extra clients and cost, brand |
| GET | `/clients` | agency admin, not acting | Clients with plan, status, installed, conversations, resolution rate, last activity |
| POST | `/clients` | agency admin, not acting | Create a client and invite its admin (audited on both companies) |
| POST | `/clients/:id/open` | agency admin, not acting | One-hour acting token `{token, expiresAt, client}` (audited `agency.client_opened`, `agency.acted_as`) |
| DELETE | `/clients/:id` | agency admin, not acting | Detach (audited on both) |
| PUT | `/branding` | agency admin + `customBranding` | Save the brand (402 otherwise; audited) |
| GET | `/companies` | superadmin | Agencies with client counts and limits; clients with their agency |
| PATCH | `/companies/:id` | superadmin | `{isAgency, clientLimit}` (audited `agency.enabled/disabled/updated`) |

### `routes/downloads.js` — `/api/downloads` (public)
| Method | Path | Purpose |
|---|---|---|
| GET | `/wordpress/support-desk-chat.zip` | The WordPress plugin, filled in for `?key=` when it is a real widget key |
| GET | `/shopify/support-desk-chat.liquid` | The Shopify snippet, likewise; `?download` makes it an attachment |

### Socket events (`websockets.js`, `socketManager.js`, `services/conversation-lifecycle.js`; single namespace; rooms `operators:<companyId>`, `operators:all`, `user:<userId>`, `<sessionId>`)

Authentication: operators pass the JWT in handshake `auth.token`; an invalid or expired one is treated as a visitor; an inactive user, a pending invitation, a revoked token or a deactivated company is refused. Operator sockets are re-checked every `SOCKET_REAUTH_MS` (60 s) and get `session-expired {reason}` and a disconnect when the person was deactivated, signed out, or their company switched off. Visitors bind a session with `resume-session` + session token, and may carry an identity in handshake `auth` (`userJwt`, or `externalId` + `userHash`; 2.15). An agency's acting token connects as an admin of that client, not taking chats. The widget's origin must be one of the tenant's allowed domains. Messaging-app customers have no socket: their messages reach operators through the same operator events, with `channel` set. No ack callbacks; replies are events. Notices to the visitor carry `code`, `params` and an English `message` (codes in 2.1).

**Client → server**
| Event | Emitter | Payload | Effect |
|---|---|---|---|
| `resume-session` | visitor | `sessionId`, `sessionToken?`, `widgetKey`, `externalId`, `userHash`, `pageUrl`, `email/name/phone` | Existing conversation: verify the token → `session-ready` (with the holding operator's name) and `session-history`, or `session-rejected`. No conversation yet: bind and issue a token, create nothing → `session-ready {pending:true}` |
| `user-message` | visitor | `message`, `messageId` (the widget's `clientMessageId`), `timestamp`, `userName?`, `consent?` | First action creates the conversation (quota; refused → `unavailable` notice); a repeated `clientMessageId` is dropped; save; `new-message` to operators; then a suggestion (if held) or the bot's reply; unanswered → `fallback` reply + "Talk to a person" choice; failed → hand-over (`model_error`); AI allowance spent → hand-over (`quota`) |
| `user-details` | visitor | `name`, `email`, `phone`, `externalId?`, `userHash?`, `consent?` | Creates the conversation if needed; store metadata, resolve/link contact → `user-details-updated` |
| `chat-opened` | visitor | — | `chat-activity {opened}` to operators |
| `user-typing` | visitor | `isTyping` | Relay to operators |
| `file-uploaded` | visitor | `fileId`, `fileName` | Record message, notify operators |
| `message-read` / `mark-all-read` | visitor | `messageId` | Relay receipts to operators |
| `message-feedback` | visitor | `messageId`, `rating: up\|down` | Stored on that bot message of this session (latest wins) → `message-feedback` to operators |
| `leave-message` | visitor | `email`, `message?`, `consent?` | Creates the conversation if needed; stores `followUp`, the email and the message; marks it waiting (`offline_message` when nobody can be reached) → `followup-saved`; `handoff-requested` to operators |
| `request-operator` | visitor | — | Creates if needed; hand-over (`visitor_request`) → `operator-requested {queued, connected, operatorName, code…}`, plus `followup-request` when nobody can be reached |
| `submit-rating` / `decline-rating` | visitor | `score`, `comment?` | CSAT → `rating-recorded`; `conversation-rated` to operators; ≤2 → `low_rating` notification |
| `visitor-identity` | visitor | — | Sent after `session-ready`: re-check the handshake identity; attach a valid one to a conversation that started anonymously; an expired token → `notice {code: 'identity_expired'}` |
| `verify-email-start` | visitor | `email`, `language?` | Send a six-digit code (limits in 2.15) → `verify-email-sent {email, expiresInSeconds, code…}` or `verify-email-result {ok:false, reason, stage:'start'}`; already verified → `verify-email-result {ok:true, reason:'already_verified'}` |
| `verify-email-code` | visitor | `code` | Check it → `verify-email-result {ok, reason?, email?, attemptsLeft?}`; on success the contact is verified by `email_code` |
| `heartbeat` | any | — | `heartbeat-ack`, re-join operator room |
| `join` | any | `sessionId` | Join a room (visitor: own only; operator: same company) → `joined-room` |
| `join-operator-room` | operator | — | Join company (or global) room |
| `operator-takeover` | operator | `sessionId`, `force?` | Claim; the holder re-joining → `operator-rejoined` only; held by a colleague needs `force` and an admin → `chat-taken-from-you` |
| `operator-message` | operator | `sessionId`, `message` | Deliver; visitor gone and has an email → sent by email (`operator-message-emailed`); email channel sends mail |
| `operator-read` | operator | `sessionId`, `messageId?` | Read receipts to the visitor (all their messages when no id) |
| `operator-typing` | operator | `sessionId`, `isTyping` | Relay to visitor |
| `request-suggestions` | operator | `sessionId`, `messageId?` | AI draft → `operator-suggestion` (`{error:true}` on failure) |
| `use-suggestion` | operator | `sessionId`, `suggestion`, `edited?` | Send it; `suggestion-used` |
| `toggle-suggestions` | operator | `sessionId`, `enabled` | Per-chat toggle → `suggestions-toggled`, `suggestions-status-changed` |
| `request-user-details` | operator | `sessionId` | Widget shows pre-chat form |
| `operator-leave` | operator (holder, or admin) | `sessionId`, `passToBot`, `force?` | Release to bot or re-queue → `operator-left` |
| `end-chat` | operator (holder, or admin) | `sessionId`, `outcome? {status, note}`, `force?` | End with outcome; system line; CSAT; webhook → `chat-ended` |
| `disconnect` | built-in | — | Visitor: `chat-activity {closed}`; operator: grace timer then release |

**Server → client**
| Event | To | Purpose |
|---|---|---|
| `session-ready` (`pending?`, `sessionToken`, `operatorName?`), `session-history`, `session-rejected` | visitor | Session binding / replay (last 50) |
| `bot-message` (`id`, `text`, `path`, `sources`, `choices?`, `cards?`, `canRate`, notice fields), `bot-typing` | visitor | Bot reply or a notice in the bot's voice |
| `operator-message`, `operator-typing`, `operator-joined`, `operator-left`, `operator-requested`, `followup-request`, `followup-saved`, `request-user-details`, `chat-ended {message, requestRating}`, `chat-transferred`, `message-read`, `rating-recorded`, `heartbeat-ack`, `joined-room`, `error` | visitor | Conversation lifecycle |
| `verify-email-sent`, `verify-email-result`, `verify-email-request` (open the code form; `askVisitor`, no caller yet), `notice` (`identity_expired`) | visitor | Identity and email codes (2.15) |
| `new-chat`, `new-message`, `conversation-message`, `handoff-requested`, `operator-requested`, `chat-activity`, `chat-reactivated`, `user-typing`, `all-messages-read`, `message-read`, `message-feedback`, `user-details-updated`, `operator-joined`, `operator-left`, `chat-ended`, `chat-assigned`, `conversation-tagged`, `conversation-note`, `conversation-note-deleted`, `conversation-deleted`, `conversation-rated`, `suggestion-used`, `suggestions-status-changed`, `workflow:published`, `workflow:hot-swap`, `workflow:unloaded` | `operators:<companyId>` (+ `operators:all`) | Queue and inbox updates (`new-chat`/`new-message` carry `channel`, including `whatsapp`, `messenger`, `instagram`; `chat-ended {reason: 'idle'}` from the idle sweep) |
| `chat-assigned-to-you`, `chat-transferred-to-you`, `chat-taken-from-you`, `operator-rejoined`, `operator-suggestion`, `operator-message-emailed`, `suggestions-toggled`, `session-expired`, `notification-created`, `notification-updated`, `notifications-all-read`, `notification-deleted` | `user:<operatorId>` or the operator's own socket | Personal nudges |
| `task-created/updated/deleted/assigned`, `comment-created/updated/deleted` | company room | Task board |

---

## 4. Data model summary (`models/`)

| Collection (model) | Purpose | Key fields |
|---|---|---|
| `companies` (Company) | The tenant | `name` (unique), `description`, `website`, `widgetKey` (`wk_…`, unique), `allowedDomains[]` (one company per domain), `identitySecret` (select:false), `assistant {persona, scope}`, `emailChannel {enabled, inboundAddress, fromName, fromAddress, inboundSecret, signature, lastInboundAt}`, `businessHours {enabled, timezone, days[{day, opensAt, closesAt, closed}], offlineMessage, closedDates[{date YYYY-MM-DD, label}]}`, `reports {minutesPerConversation 1–240}`, `connector {enabled, url, secret (encrypted), capabilities[], sdkVersion, lastCheckedAt, lastError}`, `routing {autoAssign, maxConcurrent 1–20 (3), assignOnStart, escalateAfterMinutes 0–240 (5)}`, `dataRetention {anonymizeAfterDays, deleteAfterDays, updatedAt, updatedBy}`, `widgetSettings` (see §5), `widgetSeen {at, origin, origins[]}`, `usageAlerts {period, warned80[], warned100[]}`, `onboarding {botTestedAt}`, `agency {isAgency, parent (the agency, indexed), clientLimit, attachedAt, detachedFrom, detachedAt}`, `branding {productName ≤60, logoUrl, primaryColor, supportEmail}` (an agency's), `createdVia superadmin\|signup`, `isActive`, `createdAt`, `createdBy` |
| `users` (User) | Staff | `username`, `email` (unique), `password` (bcrypt), `role superadmin\|company_admin\|operator`, `company` (required for non-superadmin), `displayName`, `name`, `isActive`, `tokenVersion`, `passwordResetTokenHash/Expires`, `invitePending`, `inviteTokenHash` (select:false), `inviteExpires`, `invitedBy`, `emailVerifiedAt`, `emailVerifyTokenHash` (select:false), `timezone`, `deletedAt`, `maxConcurrentChats`, `acceptingChats`, `lastLogin`, `createdBy` |
| `revokedtokens` (RevokedToken) | Sessions signed out one at a time | `_id` = the token's `jti`, `user`, `expiresAt` (TTL) |
| `subscriptions` (Subscription) | Plan choice per company | `company` (unique), `planId`, `status trialing\|active\|past_due\|cancelled\|suspended`, `currentPeriodEnd`, `trialEndsAt`, `limitOverrides` map, `overageAllowed`, `pricingModel flat\|per_resolution`, `spendCap`, `spendCapUpdatedAt`, `managedByAgency`, `externalCustomerId/SubscriptionId`, `externalEventAt` |
| `usages` (Usage) | Monthly meters | `company`+`period YYYY-MM` (unique), `conversations`, `messages`, `aiResponses`, `operatorMessages`, `filesUploaded`, `fileBytes`, `knowledgeChunksIngested` (never written), `limitHits`, `resolutions`, `resolutionsCountedAt`, `stripeReport {reported, day, pending {identifier, value, timestamp}}` |
| `conversations` (Conversation) | A chat, email or messaging-app thread, created at the visitor's first action | `sessionId` (unique; `whatsapp-<hex>` etc. for app threads), `sessionTokenHash`, `channel chat\|email\|whatsapp\|messenger\|instagram`, `external {provider, accountId, userId, lastInboundAt}` (app threads; `userId` cleared on anonymising), `email {subject, from, to, messageIds[], lastMessageId}`, `messages[] {content, sender user\|bot\|operator\|system, messageId, isRead, readAt, fileId, fileName, operatorId, operatorName, emailMessageId, attachments[], sources[{title, url}], path workflow\|canned\|assistant\|fallback\|handoff\|system, unanswered, feedback {rating up\|down, at}, correction {kind knowledge\|canned, refId, at, by}, timestamp}`, `status active\|ended\|archived`, `hasOperator`, `operatorId/Name`, `suggestionsEnabled`, `botEnabled`, `metadata` map (name/email/phone/consent), `tasks[]`, `notes[] {body, author, authorName, system, createdAt}`, `transferredFrom`, `tags[]`, `assignment {method auto\|manual, at}`, `awaitingOperatorSince`, `handoff {requestedAt, reason visitor_request\|bot_unanswered\|model_error\|quota\|workflow\|offline_message, summary ("Asked: …"), escalatedAt (long-wait alert sent)}`, `operatorEverJoined`, `firstOperatorJoinedAt`, `firstOperatorReplyAt`, `outcome {status resolved\|follow_up\|unresolved\|spam, note, by, at}`, `followUp {email, requestedAt, lastSentAt}`, `workflowState {workflowId, version, awaiting, variables, updatedAt}`, `pendingAction`, `rating {score 1–5, comment, ratedAt, operatorId/Name, handledBy bot\|operator}`, `ratingRequestedAt`, `startedAt`, `endedAt`, `lastActivity`, `company`, `contact`, `anonymizedAt`, legacy `userId`, `domain`. Partial index on unanswered messages for the gaps list; index on `company`+`external.provider`+`external.userId`+`status` for app threads. A message from an app keeps the provider's id in `messageId`. |
| `contacts` (Contact) | A person across sessions | `company`, `externalId` (unique per company when set), `identityLevel anonymous\|claimed\|verified`, `verifiedBy jwt\|hmac\|email_code`, `verifiedAt`, `signedAttributes` map (from a JWT's `attrs`), `email`, `phone`, `name`, `sessionIds[]`, `attributes` map, `tags[]`, `conversationCount`, `firstSeenAt`, `lastSeenAt` |
| `tasks` (Task) | Follow-up work | `title`, `description`, `dueDate`, `priority low\|medium\|high\|urgent`, `assignee`, `assigneeName`, `status open\|in_progress\|completed`, `conversationId`, `parentTaskId`, `contactInfo {name, phone, email}`, `createdBy`, `createdByBot`, `company`, `completedAt` |
| `comments` (Comment) | Task comments | `taskId`, `content`, `author`, `authorName`, `isEdited`, `attachments[]` (no `company`; routes check the task) |
| `activities` (Activity) | Task activity feed | `taskId`, `type` (task/comment events), `user`, `userName`, `description`, `metadata`, `changes {field, oldValue, newValue}`, `company` |
| `notifications` (Notification) | The bell (and push, 2.17) | `type task_due_tomorrow\|task_due_today\|task_overdue\|task_assigned\|chat_assigned\|chat_transferred\|visitor_waiting\|low_rating\|usage_warning`, `taskId` (required for `task_*`), `sessionId`, `link`, `userId`, `read`, `message`; TTL 30 days |
| `responsetemplates` (ResponseTemplate) | Canned replies | `company`, `name`, `role greeting\|fallback\|offTopic\|handoff\|null`, `triggers[]`, `responses[]`, `variables` map, `threshold`, `enabled`, `useCount`, `lastUsedAt` |
| `assistantprofiles` (AssistantProfile) | The guided persona builder's answers | `company` (unique), `businessName`, `whatYouDo`, `tone friendly\|professional\|brief`, `neverGuess[]`, `neverGuessOther`, `handover`, `updatedBy`, `updatedAt` |
| `actions` (Action) | Saved calls the assistant or workflows make | `company`, `name` (slug), `title`, `description` (when to use), `inputs[] {name, description, type, required, source visitor\|verified\|constant, value, attribute}`, `request {…, credential encrypted}`, `response {mode, fields[{name, path}]}`, `mode auto\|workflow_only`, `requiresVerified`, `verification signed\|email` (whether an email code is enough), `enabled`, `createdBy` |
| `bookings` (Booking) | An appointment made through us | `company`, `conversation`, `sessionId`, `contact`, `provider calcom\|google\|calendly`, `providerRef`, `reference` (`BK-XXXXXX`, unique per company), `serviceId`, `serviceName`, `start`, `end`, `timezone`, `name`, `email`, `phone`, `notes`, `status booked\|pending\|cancelled\|rescheduled\|no_show`, `url` (a Calendly link), `providerData`, `createdBy bot\|operator`, `createdByUser`, `reminderSentAt`, `reminderAttempts`, `cancelledAt`, `cancelledBy visitor\|operator`, `rescheduledFrom/To`, timestamps |
| `calendarconnections` (CalendarConnection) | The company's one connected calendar | `company` (unique), `provider`, `enabled`, `credentials {apiKey, accessToken, refreshToken, expiresAt, scope}` (encrypted, select:false), `account {name, email, timezone, handle}`, `services[] {id, name, duration 5–480, buffer 0–240, enabled, hidden, providerData}`, `calendarId` (primary), `hours[] {day, closed, opensAt, closesAt}`, `inviteAttendee`, `minNoticeMinutes` (120), `horizonDays` (14), `reminders` (true), `connectedBy`, `connectedAt`, `lastCheckedAt`, `lastError` |
| `channelaccounts` (ChannelAccount) | A connected WhatsApp number, Facebook Page or Instagram account | `company`, `provider whatsapp\|messenger\|instagram` (unique per company), `enabled`, `phoneNumberId`, `wabaId`, `displayPhoneNumber`, `pageId`, `igUserId` (each unique across tenants), `displayName`, `accessToken`, `appSecret` (encrypted, select:false), `verifyToken` (select:false), `template {name, language, param positional\|named\|none, paramName}`, `humanAgentTag`, `status pending\|connected\|error\|disabled`, `webhookVerifiedAt`, `lastInboundAt`, `lastError {message, at}` |
| `pushsubscriptions` (PushSubscription) | One browser's push subscription | `user`, `company`, `endpoint` (unique), `keys {p256dh, auth}`, `vapidKey`, `label`, `level all\|important\|none`, `previews` (false), `jti`, `tokenVersion`, `createdAt`, `lastSeenAt`, `lastSentAt` |
| `mcpservers` (McpServer) | A tenant's remote MCP server | `company`, `name`, `slug` (unique per company), `url`, `auth {type none\|bearer\|header, headerName, secret (encrypted, select:false)}`, `status new\|connected\|error`, `lastCheckedAt`, `lastError`, `protocol {era modern\|legacy, version}`, `serverInfo {name, version}`, `warnings[]`, `tools[] {name, title, description, inputSchema (JSON text), readOnlyHint, destructiveHint, enabled (false), mode automatic\|workflow_only, verifiedOnly, needsConfirmation, available, changedAt, lastCalledAt}`, `createdBy`, timestamps |
| `visitorcodes` (VisitorCode) | A pending email verification code | `company`+`sessionId` (unique), `email`, `codeHash`, `salt`, `attempts`, `expiresAt` (TTL), `createdAt` |
| `knowledgechunks` (KnowledgeChunk) | Embedded knowledge | `company`, `sourceId` (`url:`, `file:`, `text:` …), `sourceType google_sheets\|pdf\|url\|upload\|manual`, `importId`, `collectionName`, `content`, `embedding[]`, `embeddingSignature`, `metadata`, `chunkIndex` |
| `knowledgesources` (KnowledgeSource) | What survives a re-import, per source | `company`+`sourceId` (unique), `title`, `text` (a pasted note as written), `refreshWeekly`, `lastRefreshedAt`, `lastError`, `updatedBy`, `updatedAt` |
| `knowledgecrawls` (KnowledgeCrawl) | A site and its latest crawl | `company`+`origin` (unique), `startUrl`, `maxPages`, `status queued\|running\|done\|failed`, `progress {phase reading\|saving, read, planned, saved, skipped}`, `imported[]`, `skipped[]` (≤50), `removed[]`, `pages[]` (the `url:` sources it owns), `error`, `errorCode`, `refreshWeekly`, `startedAt`, `finishedAt`, `heartbeatAt`, `lastRunAt`, `createdBy` |
| `testcases` (TestCase) | Saved bot tests (≤50 per company) | `company`, `question`, `expect {type contains\|handover\|cites, value}`, `lastRun {passed, answer, path, reason, at}`, `createdBy`, timestamps |
| `gapdismissals` (GapDismissal) | Unanswered-question groups dealt with | `company`, `key`, `tokens[]`, `question`, `reason dismissed\|taught`, `at`, `by` |
| `knowledgedocuments` (KnowledgeDocument) | Google Sheets import (unread by assistant) | `userId`, `spreadsheetId`, `sheet`, `title`, `columns[{name, description, exclude}]`, `rows[][]` |
| `googletokens` (GoogleToken) | Per-user OAuth tokens for the Sheets import (plaintext) | `userId` (unique), `accessToken`, `refreshToken`, `scope`, `tokenType`, `expiryDate` |
| `workflows` (Workflow) | Visual flow | `name`, `description`, `version`, `status draft\|published\|archived`, `trigger {type always\|intent\|keywords, description, keywords[]}`, `liveVersion`, `liveTrigger`, `nodes[] {id, type, position, data}`, `edges[] {id, source, target, sourceHandle, targetHandle}`, `compiledChain`, `company`, `rootSystemPrompt`, `moderationConfig`, `createdBy`, `publishedAt`, `publishedBy`, `executionStats {runs, completions, handoffs, errors, lastRunAt}` |
| `workflowversions` (WorkflowVersion) | Version snapshots | `workflowId`, `version`, `nodes`, `edges`, `trigger`, `compiledChain`, `changeDescription`, `isRollback`, `rollbackFromVersion`, `performanceMetrics`, `createdBy` |
| `webhooks` (Webhook) | Outbound endpoints | `company`, `url`, `description`, `events[]`, `secret` (encrypted), `enabled`, `consecutiveFailures`, `disabledAt/Reason`, `lastSuccessAt/FailureAt` |
| `webhookdeliveries` (WebhookDelivery) | Delivery log + retry queue | `webhook`, `company`, `event`, `payload`, `status pending\|delivered\|failed`, `attempts`, `nextAttemptAt`, `responseStatus`, `responseBody`, `error`, `durationMs`, `deliveredAt`; TTL 30 days |
| `apikeys` (ApiKey) | Public API credentials | `company`, `name`, `prefix`, `hash` (select:false), `scopes[]`, `createdBy`, `lastUsedAt`, `expiresAt`, `revokedAt/By` |
| `auditlogs` (AuditLog) | Append-only audit | `company` (null = platform), `actor {id, username, displayName, role}`, `action`, `target {type, id, label}`, `details`, `outcome success\|failure\|denied`, `ip`, `userAgent`, `at`; TTL `AUDIT_RETENTION_DAYS` |
| `ratelimitcounters` (RateLimitCounter) | Cross-instance rate limits | `_id "<prefix>:<key>:<window>"`, `hits`, `expiresAt` |
| `stripeevents` (inline in `services/stripe.js`) | Webhook idempotency | `eventId` (unique), `type`, `receivedAt`; TTL 30 days |
| `sessions` (connect-mongo) | Express sessions | TTL 24 h |

---

## 5. Configuration surface

### Widget `data-*` attributes (`widget-loader.js`)
| Attribute | Default | Effect |
|---|---|---|
| `data-widget-key` | none | Identifies the tenant (`?key=`, socket auth, session payloads) |
| `data-server-url` | origin of the loader script | Base for config, assets, socket, uploads |
| `data-user-jwt` | none | A short-lived HS256 token the tenant's server signed (2.15); its `sub` is the user id. Preferred over the hash |
| `data-user-id` | none | Tenant-signed visitor id (with the hash) |
| `data-user-hash` | none | `HMAC-SHA256(identitySecret, userId)` hex |
| `data-chatbot-name` | server / `Assistant` | Header title (snippets from older dashboards still set it, which overrides later dashboard changes) |
| `data-primary-color` | server / `#2196f3` | `--primary-color` |
| `data-position` | server / `right` | `left` or `right` |
| `data-initial-message` | server `welcomeMessage` | Greeting |
| `data-privacy-policy-url` | server setting, else no link | Pre-chat form and consent link |
| `data-require-name` / `data-require-email` / `data-require-phone` | server setting (`false` for new companies) | Mandatory pre-chat fields |
| `data-language` | server `language`, else browser | `en es fr de it pt ro ru uk pl nl` or `auto` |
| `data-dir` | follows the language | `ltr`, `rtl` or `auto` |
| `data-logo-url` | server `logoUrl` | https image in the header |
| `data-preview` | off | The dashboard's preview: draw from attributes only, no socket, session, config fetch or usage |

### `Company.widgetSettings` (`models/company.js`, edited under Channels → Website widget)
`chatbotName` ('Assistant'; while unchanged the header shows the company's name), `primaryColor` ('#2196f3'), `position` (`left|right`), `welcomeMessage` ('Hi! How can we help you today?'), `logoUrl` (https only), `language` (`auto` or one of the eleven), `requireName` (false), `requireEmail` (false), `requirePhone` (false) — companies created before 2026-10-22 keep a stored `true` until edited, `privacyPolicyUrl` (http(s) only), `suggestedQuestions[]` (≤4, ≤120 chars), `consentRequired` (false), `consentText` (≤300), `proactive {enabled, text ≤200, delaySeconds 5–120 (20), pathContains}`. Also per company: `allowedDomains`, `widgetKey` (rotatable), `businessHours`, `emailChannel`, `routing` (with `escalateAfterMinutes`), `dataRetention`, `reports`, `assistant`, `connector`, `identitySecret`, `agency`, `branding`; and in their own collections the calendar connection (2.13), channel accounts (2.14), MCP servers (2.16) and, per person and device, push subscriptions (2.17). The screen confirms before removing a domain and warns when no privacy policy is set.

### Environment variables (names only; from `.env.example` and `process.env` reads)
- **Core:** `NODE_ENV`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY`, `LOG_LEVEL`, `ALLOWED_DOMAINS`
- **Database:** `MONGODB_URI`, `MONGO_POOL_SIZE`, `MONGODB_TEST_URI` (tests)
- **Secrets:** `JWT_SECRET`, `SESSION_SECRET`, `SECRETS_KEY`
- **Accounts:** `PRODUCT_NAME` (default "Support Desk"), `SIGNUP_ENABLED` (default on), `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET`, `SOCKET_REAUTH_MS` (60000)
- **AI:** `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CLASSIFIER_MODEL`, `OPENAI_TIMEOUT_MS`, `EMBEDDING_MODEL`, `WORKFLOW_PICK_THRESHOLD` (0.45), `WORKFLOW_PICK_TIMEOUT_MS` (4000)
- **Knowledge / vectors:** `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `MONGODB_VECTOR_INDEX`, `VECTOR_SCAN_LIMIT`, `MAX_PDF_BYTES`, `MAX_PAGE_BYTES`, `KNOWLEDGE_UPLOAD_MAX_BYTES`, `KNOWLEDGE_CRAWL_MAX_PAGES`, `KNOWLEDGE_CRAWL_TIME_BUDGET_MS`, `GOOGLE_SHEETS_UI` (default false)
- **Uploads:** `MAX_UPLOAD_BYTES`
- **Scale / runtime:** `REDIS_URL`, `SCHEDULER_ENABLED`, `OPERATOR_GRACE_MS`, `WORKFLOW_CACHE_TTL_MS`, `WORKFLOW_STATS_FLUSH_MS` (30000), `IDLE_CLOSE_HOURS` (24)
- **Rate limits:** `RATE_LIMIT_API_MAX`, `RATE_LIMIT_CHAT_MAX`, `RATE_LIMIT_DASHBOARD_MIN` (300), `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_IP_MAX`, `RATE_LIMIT_PASSWORD_RESET_MAX`, `RATE_LIMIT_SIGNUP_MAX` (5), `RATE_LIMIT_ACCOUNT_LINK_MAX` (30), `RATE_LIMIT_VERIFY_RESEND_MAX` (5), `VERIFY_EMAIL_HOURLY_LIMIT` (200, in-chat email codes per company per hour)
- **Push:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- **Google Calendar booking:** `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI` (falls back to `GOOGLE_CLIENT_ID/SECRET` and `PUBLIC_URL/api/booking/google/callback`)
- **Retention:** `RETENTION_ANONYMIZE_DAYS`, `RETENTION_DELETE_DAYS`, `ARCHIVED_RETENTION_DAYS` (legacy), `AUDIT_RETENTION_DAYS`, `WEBHOOK_LOG_RETENTION_DAYS`
- **Backups:** `BACKUPS_ENABLED`, `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS`, `TENANT_BACKUPS_ENABLED`, `TENANT_BACKUP_RETENTION_DAYS`
- **Monitoring / alerting:** `METRICS_TOKEN`, `ALERTS_ENABLED`, `EMAIL_ALERTS_ENABLED`, `ALERT_RECIPIENTS`, `ALERT_CHECK_INTERVAL`, `ALERT_FROM_EMAIL`
- **Platform mail (alerts, resets, confirmations, invitations, usage warnings):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- **Email channel (outbound replies and chat follow-ups):** `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`, `EMAIL_ALLOW_TENANT_FROM` (default false)
- **Google Sheets import:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`
- **Outbound HTTP:** `ACTIONS_ALLOW_HTTP`, `ACTIONS_USER_AGENT`, `WEBHOOK_USER_AGENT`
- **Billing:** `TRIAL_DAYS`, `AI_COST_PER_REPLY` (0.002, for the platform's cost estimate), `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_AGENCY`, `STRIPE_PRICE_ENTERPRISE`, `STRIPE_ALLOW_CLIENT_REFERENCE`, `STRIPE_PRICE_RESOLUTION`, `STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION` (any `STRIPE_PRICE_<PLAN>_PER_RESOLUTION`), `STRIPE_RESOLUTION_EVENT` (resolutions)
- **Placeholder prices (`config/plans.js` `PRICING_ENV`):** `PLAN_AGENCY_PRICE` (299), `PLAN_AGENCY_CLIENTS_INCLUDED` (10), `PLAN_AGENCY_CLIENT_PRICE` (19), `PLAN_AGENCY_CLIENT_LIMIT` (50), `PLAN_AGENCY_CLIENT_PLAN` (professional), `PRICE_PER_RESOLUTION_BASE` (49), `PRICE_PER_RESOLUTION` (0.49), `PRICE_INCLUDED_RESOLUTIONS` (0)
- **Connector SDK (tenant side):** `CHATBOT_CONNECTOR_SECRET`

---

## 6. Known gaps

Re-checked against the code on 2026-10-22, after Phase 2. What the owner has decided to build or arrange later — store listings for the plugins, Meta App Review and Google OAuth verification, SOC 2, an EU region, overage billing, billing an agency's extra clients, workflows calling MCP tools, OAuth MCP servers, SLAs, enterprise analytics, workflow loops, dashboard translation, dependency upgrades — is in [todo.md](../todo.md) and not repeated here.

**Not exercised against the real service:** every Phase 2 integration — Meta (WhatsApp, Messenger, Instagram), Cal.com, Google Calendar, Calendly, Stripe's Billing Meter, MCP servers, push services, and the WordPress and Shopify installs — is tested against stubs only.

**Behaviour a customer could notice:**
- An operator reply sent in the seconds before the server notices a visitor left goes to the chat, not by email (the switch is made on whether the visitor still has a socket).
- `conversation.ended` fires for operator-ended chats and for idle web chats; an email or messaging-app thread is never ended automatically, so for those it fires only when an operator ends one.
- Messaging apps: an operator cannot send a file to a WhatsApp, Messenger or Instagram customer; no typing indicator is sent; the notices the platform sends there are English only; there is no rating prompt. One customer's messages are serialised per process only (`services/channels/inbound.js#serially`), so with several instances two arriving at once are answered side by side; the unique index `one_open_conversation_per_app_customer` keeps them in one conversation.
- An MCP tool set to "workflow only" is not used at all: no workflow node can call MCP tools. A tool's "verified customers only" needs a signed visitor; an email code does not count.
- A JWT's signed `attrs` are stored and shown in People but cannot feed an action input (only `externalId`, `email`, `name`, `phone`) and are not workflow variables.
- The REST fallback `POST /api/chat/message` accepts the HMAC pair but not a JWT.
- `services/visitor-verification.js#askVisitor` (open the code form in a visitor's chat) has no caller; only the assistant offers verification.
- Booking reminders are in English; Cal.com is reached at `api.cal.com` only (no self-hosted Cal.com); a booking whose calendar has since been disconnected cannot be cancelled from the dashboard ("cancel it there").
- The widget listens for a `user-message` echo (other devices) that the server never emits; tabs of one browser stay in step through `BroadcastChannel`, other devices only on reload.
- Every workflow Knowledge step searches the tenant's knowledge base whatever its source type says. New nodes no longer offer `google_sheets`, `pdf` or `url`; old nodes keep the setting, labelled as an older one. `knowledge-connector.js#loadGoogleSheets` uses the google-spreadsheet v3 API (`useServiceAccountAuth`) against the installed v4.1.4.
- Write confirmation for Actions (and MCP tools) recognises English affirmatives only.

**Money:**
- `overageAllowed` lets a tenant past a limit and nothing bills for it.
- Clients beyond an agency's included ones are counted and priced on its Clients screen; nothing reports them to Stripe.
- When a tenant lowers its spending cap below what was already reported, the next daily report sends a negative difference to the Stripe meter; whether Stripe accepts it has not been tried.

**Security and data handling:**
- Plaintext secrets: `Company.identitySecret`, `Company.emailChannel.inboundSecret`, `ChannelAccount.verifyToken` (select:false only; the last is a value Meta echoes, not a credential) and `GoogleToken` access/refresh tokens (no protection at all). Without `SECRETS_KEY` the encryption key silently derives from `SESSION_SECRET`.
- Per-tenant backups include every `select:false` field (encrypted credentials, the plaintext identity and inbound secrets, token hashes), as a `mongodump` would; whoever can read `backups/` can read those.
- Inbound email trusts only the shared secret; SendGrid/Mailgun/Postmark signatures are not verified. The email router's 10 MB body parsers sit behind the global 1 MB parser, so the larger limit is unreachable.
- Whole-database backup create/restore writes no audit entry.
- `TaskService.assignTask` is scoped to the caller's company (a superadmin's call is not). `PATCH /api/companies/:id/users/:userId/status` (superadmin) skips the seat quota on reactivation.
- `GET /api/workflow-execution/health` is unauthenticated; `POST /api/workflow-execution/reload` loads a workflow of any status into the live runtime; users without a company key the runtime on their user id.
- `GET /api/operations/status` is available to company admins, not only superadmins.
- `Authorization: Bearer <jwt>` is honoured by the rate limiter but not by `auth`; `middleware/auth.js` exports `companyAdmin` and `sameCompany` that no route uses.
- Connector SDK is unpublished (`@chatbot-platform/connector-sdk` in-repo only); replay protection is window-only (no nonce) for both connector and webhook signatures.

**Housekeeping:**
- `Usage.knowledgeChunksIngested` is never incremented; `messages`, `operatorMessages`, `fileBytes` are counted but not limited or billed.
- `routes/mcp.js`'s header comment says the actions meter counts only saved Actions; `services/usage.js` counts switched-on MCP tools too, which is what the route's own check relies on.
- `VERIFY_EMAIL_HOURLY_LIMIT` is read but not listed in `.env.example`.
- `moderation.customFilters` are compiled but never evaluated; `knowledge.vectorCollections` in the compiled plan is always empty.
- Transfer is load-then-save (not atomic); when everyone is busy the waiting queue has no re-sweep (the long-wait alert re-notifies people, it does not reassign).
- Notification TTL expires all notifications after 30 days, read or not; deadline sweeps and the scheduler's clock times use server-local time, not the company's timezone.
- `MongoRateLimitStore.resetKey()` ("unblock a tenant") has no route or scheduled caller.
- Retention covers conversations only; contacts, tasks, bookings and knowledge chunks never expire (GDPR erasure does remove bookings).
- Server routes with no UI: claim (the inbox uses the socket), REST end, company-admin routes under `/api/companies/:id/admin`, backups, workflow archive and `active/current`, workflow-execution routes, `check-deadlines`, `POST /api/gdpr/consent`.
- Untested: `services/backup.js` (the mongodump path), `services/scheduler.js` (the jobs it calls are tested; its cron wiring is not).

**Fixed in Phase 2:** `conversation.handoff.summary` is written; `visitor_waiting` notifications are created (long waits); idle web chats end, so `conversation.ended` fires for bot-only conversations; the server sends a `notice` event (`identity_expired`); `DELETE /api/companies/:id` purges the company's data and files; `TaskService.assignTask` is company-scoped; the setup checklist's persona step follows the persona the assistant actually uses; ending or leaving a colleague's chat needs an explicit `force`; `customBranding` means something (agencies); `WORKFLOW_PICK_*` and `WORKFLOW_STATS_FLUSH_MS` are in `.env.example`.

**Fixed since the 2026-09-09 list:** the canned-reply save path; role gating; operator attachments; in-product checkout; `conversation.started` (fires, chat and email) and `task.created` (fires for people's tasks); the `fallback` and `handoff` canned-reply roles; file-upload knowledge (`upload` chunks now have a producer) and scheduled re-sync; workflow run statistics persisted; the "Only Router and Action nodes can branch" message; audit coverage of company create/update/delete, operator creation and password resets; comment edit/delete scoped to their task; the waiting visitor told to leave an email when nobody can be reached instead of only reporting `offlineMessage`; the widget JS API, translations and consent; operator invitations; GDPR export and erase and contact merge in the dashboard; `logoUrl` rendered.
