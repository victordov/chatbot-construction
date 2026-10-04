# Chatbot Platform — Functionality Map

_Read from the working tree at `/Users/undefined/dev/proj/personal/chatbot-construction` on 2026-09-09 (branch `production-readiness`, uncommitted changes included). Every statement below is taken from the code; file paths are relative to the repo root._

> **Since this was written (2026-10-05):** the dashboard was restructured and moved to `client/`; knowledge gained site crawl, file upload and citations; saved Actions the assistant can call, Test your bot, in-product checkout, operator attachments and widget translations were added. [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) describes them. The "Not present" lists and section 6 below are as of 2026-09-09; [docs/PRODUCT.md](PRODUCT.md) section 6 is the current list.

---

## 1. What the product is

A multi-tenant customer-support chat SaaS (Node.js 20, Express 4, MongoDB via Mongoose 8, socket.io 4, OpenAI). Each tenant ("company") embeds a JavaScript widget on its own website; visitors chat with an AI assistant that answers from the tenant's own knowledge base and/or a published visual workflow, and can be handed to a human operator working in the `/admin` dashboard. Email is a second inbound channel into the same inbox. Tenants can expose their own catalogue/appointment data to the bot through a signed connector SDK, call any HTTP API from a workflow, receive signed outbound webhooks, and pull their data through a read-only public API. Plans (Trial/Basic/Professional/Enterprise) meter conversations, AI replies, seats, workflows and knowledge chunks; Stripe webhooks move a tenant onto a paid plan.

Three user types:

| User | Where | What they are |
|---|---|---|
| **Visitor** | The tenant's website, inside the widget (`public/widget/js/widget.js`) | Anonymous by default; can self-report name/email/phone (identity `claimed`) or be vouched for by the tenant with an HMAC (`verified`). Authenticated to the socket only by a per-conversation session token. |
| **Operator / company admin** | `/admin` dashboard (`public/admin/index.html`, modules in `client/admin/*` bundled to `public/dist/`) and the workflow editor (`public/admin/workflow-editor.html`, `client/workflow-editor/`) | Roles `operator` (handles chats, tasks, contacts, analytics) and `company_admin` (additionally manages operators, widget, assistant, knowledge, workflows, webhooks, billing view, audit, retention, API keys). Both belong to exactly one company (`models/user.js` requires `company` for these roles). |
| **Superadmin** | Same dashboard, extra sections | Platform operator with `company: null`. Creates companies and their admins, changes plans/overage/limit overrides, sees every tenant's usage, runs and restores backups, sees platform-level audit entries. Bootstrapped once via `POST /api/auth/create-superadmin` while the users collection is empty. |

Tenant resolution (`services/tenant.js`): a company is identified by its `widgetKey` (`wk_…`, pasted into the embed snippet) or, failing that, by the request `Origin`/`Referer` matching its `allowedDomains`. Every conversation is stamped with the company on creation; REST routes are scoped with `utils/query.js#companyFilter`; operators join a per-company socket room `operators:<companyId>` and superadmins join `operators:all`.

---

## 2. Feature map

### 2.1 Widget (`public/widget/js/widget-loader.js`, `public/widget/js/widget.js`, `routes/widget.js`)

**Loading.** The tenant pastes one `<script>` tag pointing at `widget-loader.js` (served `no-cache`; the widget itself is served content-hashed and cached immutable for a year, `services/asset-manifest.js`, `server.js`). The loader fetches `GET /api/widget/config?key=<widgetKey>` (credentials included), merges defaults ← server `widgetSettings` ← `data-*` attributes, injects the hashed `widget.js`, then calls `window.ChatbotWidget.init(config)`. If the config fetch fails the widget still loads with default branding. No iframe; the widget renders into an open Shadow DOM under a fixed-position host `div` (`z-index: 2147483000`). socket.io client is loaded from `<serverUrl>/socket.io/socket.io.js` unless `window.io` already exists.

**Server config endpoint.** `GET /api/widget/config` is public. Known tenant → `{recognised:true, companyName, settings (allow-listed presentation fields), availability:{open, canReachOperator, offlineMessage, opensAt}, assets}`; unknown tenant or any error → defaults with `recognised:false`.

**Visitor-facing features (all in `widget.js`):**
- Launcher button with ARIA labels; chat window `role="dialog"`; Escape closes; open state synced across tabs via `BroadcastChannel('chatbot_widget_channel')`.
- Welcome message (`initialMessage`, server `welcomeMessage`) shown only for fresh sessions.
- Business-hours closed notice from `availability` (`offlineMessage` + "We reopen <opensAt>").
- Pre-chat form (name/email/phone) shown when any field is required (`requireName/Email/Phone`) and details are not stored; privacy-policy link; validation with `role="alert"`; details persisted in `localStorage` for 30 days; operator can force it (`request-user-details`).
- Message rendering: text with minimal markdown (`**bold**`, `*italic*`, line breaks); sender name and time; sent/read ticks (`message-read`); quick-reply buttons from `message.choices` (max 8; tapping sends the label); cards from `message.cards` — `Slot` cards render as tappable time buttons, other cards as product cards (image, title, price, "View" link); file download links; system notices; typing indicator for bot and operator.
- "Talk to a person" button → `request-operator`; shows "X has joined" or "Nobody is free right now… in the queue".
- File upload (paperclip; png/jpg/gif/webp/pdf/txt/csv/doc/docx/xls/xlsx; 10 MB client cap) via `POST /api/upload`, then `file-uploaded` socket event.
- CSAT prompt on `chat-ended {requestRating:true}`: 1–5 buttons, score sent immediately, optional comment afterwards, "No thanks" → `decline-rating`.
- Session persistence: `chatbotSessionId` (UUID) + `chatbotSessionToken` in localStorage; every socket `connect` re-emits `resume-session`; `session-rejected` → new session; `session-ready` with `sessionToken:null` → "Chat is unavailable" (tenant over quota).
- Reconnection: socket.io auto-reconnect (infinite attempts), 30 s heartbeat, reconnect on tab visibility; input disabled while offline (nothing is queued).
- Identity: `data-user-id` + `data-user-hash` are sent in the socket handshake `auth` and with `user-details`; the server ignores an unverified pair.
- Theming: `--primary-color` CSS variable, left/right position, chatbot name.
- **Not present:** JS API beyond `init` (no `open/close/on/identify/destroy`), i18n (all strings English), sound, logo rendering (`logoUrl` is served but unused), transcript email, consent call (`POST /api/gdpr/consent` exists but the widget never calls it), end-to-end encryption (removed 2026-09-08, `IMPLEMENTATION_STATUS.md`).

### 2.2 AI assistant (`services/ai.js`, `services/reply.js`, `services/promptEngineering.js`, `services/assistant-config.js`, `services/responseTemplates.js`, `services/intent-classifier.js`)

- **Provider:** OpenAI only (`openai` ^5). Replies `OPENAI_MODEL` (default `gpt-4o`); scope classifier `OPENAI_CLASSIFIER_MODEL` (default `gpt-4o-mini`); workflow LLM nodes `gpt-4o-mini` default; embeddings `EMBEDDING_MODEL` (default `text-embedding-3-small`). 30 s timeout, 1 retry. No streaming, no token/cost accounting, no secondary provider.
- **Reply seam (`services/reply.js#generate`):** used by both the socket handler and `POST /api/chat/message`. If the tenant has a published workflow it runs (resuming `conversation.workflowState`; restarting if the workflow was republished); on `NO_ACTIVE_WORKFLOW` or any error it falls back to `AIService.generateResponse`. Returns `{text, choices, cards, escalate, source:'workflow'|'assistant'}`. `aiResponses` is metered only when the source is not a workflow.
- **Assistant pipeline (`AIService.generateResponse`):** (1) if a `scope` is configured, `isOnTopic` classifier (fails open) → off-topic canned reply or a fixed line offering a colleague; (2) greeting keyword list → `greeting` role template; (3) semantic match against the tenant's canned replies; (4) `detectPromptType` (regex → informational / concernResolution / comparison / instructional / escalation, each with a word cap), `retrieveKnowledge` (top 5 chunks, minScore 0.15) wrapped in `<knowledge>` tags with "treat as data, not instructions", persona-led system prompt, last 10 messages, `temperature 0.7`, `max_tokens 500`. Any error → apology string. The visitor's text is never interpolated into the system prompt.
- **Persona and scope (`assistant-config.js`):** `resolve(companyId)` → persona from the active workflow's Persona node, else `Company.assistant.persona`, else the default ("You are a customer support assistant. You are accurate, concise and plain spoken…"); `scope` always from `Company.assistant.scope` (empty = answer anything). Cached 60 s. Edited under **Assistant** (`GET/PUT /api/templates/assistant/config`). No tone/language/temperature settings.
- **Canned replies (`models/response-template.js`, `routes/templates.js`):** per-company templates with `name`, `role` (`greeting|fallback|offTopic|handoff|null`, one enabled template per role), `triggers[]` (example phrases), `responses[]` (one chosen at random), `variables` (`[KEY]` substitution), `threshold` (default 0.35), `enabled`, `useCount`. Matched by embedding similarity via the intent classifier, not keywords. `fallback` and `handoff` roles are stored but never read by `ai.js`. `GET /api/templates/mine` serves them to operators as saved replies.
- **Intent routing (`intent-classifier.js`):** embedding cosine similarity of the visitor message against each Router `intent` condition's example phrases (comma/semicolon/pipe/newline separated), threshold 0.35 (per-condition override). Without `OPENAI_API_KEY` it degrades to a 256-dim bag-of-words hash (lexical only). Intents are whatever a workflow author types; there is no fixed list.
- **Operator suggestions (`generateOperatorSuggestion`):** when an operator holds the chat, each visitor message (or `request-suggestions`) produces a draft delivered only to that operator (`operator-suggestion`), gated by plan feature `aiSuggestions`, `conversation.suggestionsEnabled`, and the `aiResponsesPerMonth` meter.
- **Handoff triggers:** visitor button (`request-operator`), workflow `operator-handoff` or `fallback.escalation`, operator takeover, operator disconnect (grace `OPERATOR_GRACE_MS`, default 60 s, then reassign or re-queue). The assistant itself never sets an escalation flag.
- **Moderation:** workflow `moderation` node → `openai.moderations.create` on input and output (fails open without a key). `customFilters` are stored but never evaluated.

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
| `booking` | Book or change an appointment | Clinics, salons, trades | Nothing | New: name/when/phone; change: reference → tag → task → confirm. |
| `account-lookup` | Answer about their account | SaaS | Identity verification + account API | `contact_verified` check → GET account → LLM answers only from returned fields; unverified → sign-in reply; error → handoff. |
| `cancellation-save` | Cancel my subscription | SaaS | Nothing | Choose reason → tag → task (high) → confirmation; "other" → handoff. |
| `complaint` | Handle a complaint | Any | Change notify address; SMTP | Ask complaint + reference → tag `complaint,urgent` → business hours → handoff or task (urgent) + email the team. |

**Compilation/validation (`workflow-compiler.js#validateWorkflow`):** non-empty, exactly one Persona present, unique ids, edges reference nodes, unknown types warned, orphan flow nodes rejected, single output on non-branching nodes, action URL/method/body checks, regex pattern checks, cycle detection. Per-node config rules live in `services/workflow.js#validateNodeData`. `POST /api/workflows/validate` always answers 200 with `{valid, errors, warnings}`.

**Preview (`POST /api/workflows/preview`):** compiles the graph from the request body (saved or not) and runs it with `simulate:true`, no session; GETs really happen, POSTs/tasks/tags/emails/connector writes are declined and reported as "would have"; returns the path of executed node ids so the editor can light them up. `POST /api/workflows/actions/test` runs one action node once and shows the raw body plus mapped outputs.

**Versioning (`models/workflow.js`, `models/workflow-version.js`):** status `draft|published|archived`; every create/update/rollback bumps `version` and snapshots a `WorkflowVersion` (nodes, edges, compiledChain, changeDescription, `isRollback`, complexity metrics); last 20 shown; rollback copies a version forward as a new version. Publishing archives the company's other published workflow; the active workflow is the newest `published`.

**Hot swap (`workflow-runtime.js`):** per-process cache keyed by company, trusted for `WORKFLOW_CACHE_TTL_MS` (30 s) then re-checked against the DB; publish hot-swaps on the publishing instance and emits `workflow:published` / `workflow:hot-swap`; update/rollback/archive/delete of a live workflow unloads it (`forgetLiveWorkflow`) and it reloads lazily on the next message. Action-node credentials are encrypted before save and never returned to the editor (only `hasSecret`).

### 2.4 Connector SDK and capabilities (`config/capabilities.js`, `sdk/`, `services/connector.js`, `services/safe-http.js`)

A tenant installs `@chatbot-platform/connector-sdk` (`sdk/index.js`, zero dependencies, Node ≥18, **not published to any registry in-repo**), implements the methods that apply, and exposes one URL. Contract:

| Capability | Kind | Input | Returns |
|---|---|---|---|
| `catalog.search` | read | `{query: string, limit?: number}` | list of `Product {id, title, price?, currency?, image?(url), url?(url), description?, inStock?}` |
| `catalog.get` | read | `{id: string}` | one `Product` |
| `availability.slots` | read | `{service?, from?(date), to?(date), limit?}` | list of `Slot {id, startsAt(date), endsAt?, label?, staff?}` |
| `availability.book` | write | `{slotId, name?, email?, phone?, notes?}` | one `Booking {id, startsAt, reference?, status?}` |

- **SDK API:** `createConnector({searchCatalog, getProduct, listSlots, bookSlot}, {secret?})` → `(req,res)` handler. `GET` answers discovery `{protocol:'chatbot-platform/connector', version, capabilities[], signed}`; `POST` reads the raw body (≤256 KB, refuses a pre-parsed body), verifies the signature, dispatches, coerces the result to the shape. Also exports `verifySignature`, `SDK_VERSION`, `CAPABILITY_METHODS`, `MAX_CLOCK_SKEW_SECONDS`, plus TypeScript types.
- **Signing:** header `X-Connector-Signature: t=<unix>,v1=<hex>`; `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`; ±300 s window; constant-time compare. Secret `csec_<48 hex>` minted by the platform, shown once, encrypted at rest; read by the SDK from `CHATBOT_CONNECTOR_SECRET`. No nonce store (replay within 5 minutes is not detected).
- **Platform side (`services/connector.js`):** settings in `Company.connector {enabled, url, secret, capabilities[], sdkVersion, lastCheckedAt, lastError}`; managed under **Settings → Your data** (`GET/PUT /api/companies/me/connector`, `POST …/check` runs discovery). `call()` validates input against the contract, refuses capabilities the connector did not advertise, caches reads 10 s, times out at 8 s, no retries, validates results (bad rows dropped, `truncated` flag, `maxItems` 25), never throws. Writes in preview return `simulated`.
- **Outbound safety (`safe-http.js`, used for connector, action nodes, webhooks, knowledge imports):** https only unless `ACTIONS_ALLOW_HTTP`, refuses private/loopback/link-local/CGNAT/multicast/IPv6-local and v4-mapped ranges at DNS-resolution time (rebinding-safe), re-validates on each of up to 3 redirects and drops credentials on host change, 256 KB response cap.
- **Consumer:** only the `capability` workflow node. The assistant does not choose capabilities itself.

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
| `conversation.started` | **nowhere** (declared only) | — |
| `conversation.ended` | socket `end-chat`, `POST /api/admin/chat/:id/end` (operator-ended only) | sessionId, endedBy, operatorName, messages, startedAt, endedAt, tags |
| `conversation.tagged` | `PUT /api/admin/chat/:id/tags` | sessionId, tags, taggedBy |
| `conversation.rated` | `services/csat.js` | sessionId, score, comment, handledBy, operatorName, ratedAt |
| `operator.assigned` | `services/assignment.js`, `POST …/claim` | sessionId, operatorId, operatorName, method |
| `contact.created` | `services/contacts.js` | contactId, name, email, identityLevel, sessionId |
| `contact.identified` | `services/contacts.js` (on becoming verified) | contactId, externalId, name, email |
| `task.created` | workflow `task` node only (not `routes/task.js`) | taskId, title, priority, dueDate, sessionId, raisedBy |

Body `{id, event, createdAt, data}`; headers `x-webhook-event`, `x-webhook-id`, `x-webhook-signature: t=<unix>,v1=<HMAC-SHA256(secret,"<t>.<body>")>`; 10 s timeout. Retries: 5 attempts at 30 s / 2 m / 10 m / 1 h for network errors, 5xx and 429; other 4xx fail immediately; 20 consecutive failures disable the endpoint with a reason. Retries are rows (`WebhookDelivery`, TTL `WEBHOOK_LOG_RETENTION_DAYS` = 30) swept every minute by `services/scheduler.js`. Secrets `whsec_<48 hex>`, encrypted at rest, shown once, rotatable. Dashboard **Webhooks** section: create/edit/enable/rotate/test/delete and a delivery log.

**Public read API (`routes/public-api.js`, `middleware/api-key.js`, `services/api-keys.js`):** `/api/v1`, `Authorization: Bearer ck_…` (or `x-api-key`); keys created under Settings → API keys, hashed (SHA-256), prefix lookup, shown once, optional expiry, revocable (row kept). Scopes `conversations:read`, `contacts:read`, `tasks:read`. Plan feature `apiAccess` checked on every request (402 otherwise); rate limit per key from plan `apiRequestsPerMinute`. Cursor paging by `_id` (`limit` 1–100, default 25; `{data, nextCursor, hasMore}`), `since`/`until` filters. Endpoints: `GET /me`, `GET /conversations` (+`status`, `tag`), `GET /conversations/:sessionId` (with transcript), `GET /contacts` (+`email`, `externalId`), `GET /tasks` (+`status`). Read-only.

**Email channel (`services/email-channel.js`, `routes/email.js`):** inbound `POST /api/email/inbound/:companyId/:provider?` with provider `generic|sendgrid|mailgun|postmark` (no IMAP/SES), authenticated only by the per-company `emailChannel.inboundSecret` (`?secret=`, `x-inbound-secret` header or body), no provider-signature verification; unknown company and disabled channel both 404. Messages are deduped by `Message-ID`, threaded by `In-Reply-To`/`References` then sender + normalised subject, quoted history stripped, and become a `Conversation {channel:'email', sessionId:'email-<hex>'}` linked to a Contact by email; operators see `new-chat`/`new-message` with `channel:'email'`. The bot never auto-replies to email. Outbound is SMTP only (`EMAIL_HOST/PORT/SECURE/USER/PASS`), sent from the operator composer with `Re:` subject, own `Message-ID`, threading headers, `X-Operator`, and the tenant's signature. Settings under **Install Widget → Email channel** (`GET/PUT /api/companies/me/email`); the GET re-shows the inbound URL including the secret.

**Google Sheets (`routes/google.js`, `services/googleAuth.js`, `services/googleSheets.js`, `services/userGoogleDrive.js`, `services/knowledge.js`, `models/knowledgeDocument.js`, `models/googleToken.js`):** a dashboard user connects their own Google account (OAuth scopes `spreadsheets.readonly`, `drive.readonly`, `userinfo.email`; signed state with 10-minute TTL; tokens stored per user, in plaintext, auto-refreshed), searches Drive for spreadsheets, picks a sheet, excludes columns, and imports rows as a `KnowledgeDocument {userId, spreadsheetId, sheet, title, columns[{name,exclude}], rows[][]}`; documents can be listed, viewed, refreshed, column-edited and deleted. **The assistant does not read these documents:** `KnowledgeDocument` is referenced only by `services/knowledge.js` and `services/tenant-backup.js`; nothing in `services/ai.js`, `services/vector-store.js`, `services/knowledge-connector.js`, `services/reply.js` or the workflow runtime touches it, and the documents are keyed by user rather than company. The only path from a sheet into `KnowledgeChunk` is `knowledge-connector.js#loadGoogleSheets` (platform service account, reachable from a workflow knowledge node with `sourceType: google_sheets`), which calls the google-spreadsheet v3 API (`new GoogleSpreadsheet(id)` + `useServiceAccountAuth`) against the installed v4.1.4 and is therefore likely broken at runtime. Routes answer 503 when `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` are unset. The UI for this lives in `public/js/admin_parts/admin-operators.js`.

### 2.6 Operator inbox (`websockets.js`, `routes/admin.js`, `services/assignment.js`, `services/availability.js`, `services/csat.js`, `services/contacts.js`, `services/task.js`, `public/js/admin_parts/admin-chats.js`, `admin-events.js`, `admin-operator-tools.js`)

- **Queue:** `GET /api/admin/active-chats`; filters All / Mine / Unassigned with live counts, tag filter; rows show operator/no-operator dot, email badge, name or session id, message count, tags, unread badge, "Disconnected" marker. Real-time via `new-chat`, `new-message`, `chat-activity`, `chat-reactivated`, `operator-joined/left`, `chat-assigned`, `conversation-tagged`, `conversation-note`, `conversation-rated`, `operator-requested`. Browser Notification and beep on new message (`sound-notifications` setting).
- **Assignment (`assignment.js`):** only when `company.routing.autoAssign` is on; candidates are operators currently in the `operators:<companyId>` socket room, `isActive` and `acceptingChats`, under capacity (`user.maxConcurrentChats` → `company.routing.maxConcurrent` → 3); pick least-loaded, tie → longest idle, tie → stable id. Atomic claim (`findOneAndUpdate` on `operatorId` null). Triggered by `request-operator`, workflow escalation, conversation start if `routing.assignOnStart`, and `release` (operator leave with `passToBot:false`, or disconnect after the grace period). Nobody available → conversation waits with `awaitingOperatorSince` set, the bot keeps answering, and nothing re-sweeps until the next trigger. No skills/language/priority routing.
- **Manual takeover / claim:** socket `operator-takeover` (`force:true` allowed for company_admin/superadmin to take a chat from a colleague, who gets `chat-taken-from-you`) or `POST /api/admin/chat/:id/claim` (409 if held). Takeover clears `workflowState`.
- **Transfer:** `POST /api/admin/chat/:id/transfer {operatorId, note}` to an active same-company operator/company_admin; writes a system note; target gets `chat-transferred-to-you`, visitor gets `chat-transferred`. Not atomic.
- **Leave / end:** `operator-leave {passToBot}` (bot resumes, or re-queue and try a colleague); `end-chat` / `POST …/end` sets `ended`, clears operator and workflow state, fires CSAT request if ≥2 visitor messages, dispatches `conversation.ended`. A visitor message on an ended chat reactivates it (`chat-reactivated`).
- **Notes:** internal notes (≤5000 chars) via `POST/DELETE /api/admin/chat/:id/notes`; never shown to the visitor or the model; system notes (transfers) are not deletable.
- **Saved replies:** `/` prefix or button in the composer opens a picker over `GET /api/templates/mine` (canned replies pre-rendered); inserts into the composer, never auto-sends.
- **AI suggestions:** "Get Suggestion" per visitor message → `request-suggestions`; card with Use / Edit / Dismiss → `use-suggestion`; per-conversation toggle `toggle-suggestions`. Plan feature `aiSuggestions` (off on Basic).
- **Multi-chat:** operators can join several chats (`joinedChats` persisted in localStorage); typing indicators both ways; read receipts; visitor detail request (`request-user-details`); edit contact info (`POST …/contact-info`).
- **Tags:** free-form, normalised (lowercase, ≤40 chars, max 20), suggestions from `GET /api/admin/tags`, `PUT …/tags`; queue filter by tag; workflow `tag` node.
- **Availability:** self-service `PUT /api/admin/me/availability {acceptingChats, maxConcurrentChats}` (header toggle). Business hours per company in an IANA timezone with per-weekday open/close minutes, `offlineMessage`, no overnight spans, no holidays (`GET/PUT /api/companies/me/hours`); status `{open, canReachOperator, operatorsOnline, opensAt}` feeds the widget and the `business-hours` node. Presence is read from socket rooms, not a status table.
- **CSAT (`csat.js`):** requested on end if ≥2 visitor messages and not asked before; 1–5, satisfied ≥4; recorded on first tap, comment may be added later, score never revised; attributed to the last operator in the transcript or `bot`; `decline-rating` remembered. Summary (rated/asked/average/csat%/response rate/distribution) on every plan; by-handler, by-operator and comments in the advanced report.
- **Contacts / identity (`contacts.js`, `models/contact.js`):** levels `anonymous` → `claimed` (typed an email) → `verified` (tenant computed `HMAC-SHA256(identitySecret, externalId)` and passed `data-user-id`/`data-user-hash`; constant-time compare). Resolution order: verified externalId → known sessionId → claimed email; verified id owned by another contact merges into it. Fields only fill gaps, `attributes` map merged. Dashboard **People**: search, verified filter, badges (Verified / Self-reported / Anonymous), edit name/email/phone/tags, conversation history; identity secret shown/rotated under Install Widget with HMAC code examples. `POST /api/contacts/:id/merge` exists without UI.
- **Tasks (`task.js`, `models/task.js`, `admin-tasks.js`):** title/description/dueDate/priority (`low|medium|high|urgent`)/assignee/status (`open|in_progress|completed`)/conversation link/contactInfo/parent (follow-ups)/`createdByBot`; filters by status/priority/assignee/search; comments (add; edit/delete exist server-side, author-only); activity feed (`models/activity.js`: created/updated/status/priority/due date/comment/completed/deleted). Real-time `task-*` and `comment-*` events to the company room.
- **Notifications (`notification.js`):** in-app only — `task_due_tomorrow`, `task_due_today`, `task_overdue` for the assignee, created by the scheduler (midnight and hourly 08–18, server-local time) and pushed as `notification-created` to `user:<id>`; bell dropdown with mark read / mark all; TTL 30 days.
- **Chat history:** paginated search, view transcript, delete (audited). Export: CSV of up to 5000 conversations (`GET /api/admin/export?type=conversations`).
- **Not present:** operator-side attachments (no attach button; `fileUrl` is never rendered in `admin_parts`), operator invite by email, skills, operator presence column, per-operator availability set by an admin.

### 2.7 Analytics (`routes/admin.js`, `services/analytics.js`, `services/csat.js`, `admin-analytics.js`)

- **Basic (`GET /api/admin/analytics`, every plan):** active chats, chats today, average response time, 7-day activity line, traffic sources (by `domain`), conversation metrics table (today/week/month: total, average duration, messages per conversation), monthly volume and response-time charts, CSAT summary for 30 days.
- **Advanced (`GET /api/admin/analytics/advanced?days=7|30|90`, plan `analytics === 'advanced'`, 402 otherwise):** `deflection {eligible, deflected, escalated, rate}`, `abandonment {total, unanswered, rate}`, `peakHours` (weekday × hour heatmap, UTC), `operators[] {conversations, replies, avgResponseSeconds, medianResponseSeconds}`, `topics[]` (top 12 term frequency over ≤2000 conversations, stop-word list), `tasks {created, completed, overdue, completionRate, avgCompletionHours}`, `satisfaction` (summary + byHandler + byOperator ≤50 + comments ≤25).
- No custom date ranges, daily series, percentiles beyond median, or report export from this service. Superadmin sees all tenants aggregated.

### 2.8 Billing and plans (`config/plans.js`, `models/subscription.js`, `services/usage.js`, `services/billing.js`, `services/stripe.js`, `routes/billing.js`, `middleware/quota.js`, `admin-billing.js`)

| | Trial | Basic | Professional | Enterprise |
|---|---|---|---|---|
| Price / month | $0 (14 days, `TRIAL_DAYS`) | $29 | $99 | negotiated (`null`) |
| Conversations / month | 100 | 500 | 5 000 | unlimited |
| AI responses / month | 500 | 2 000 | 25 000 | unlimited |
| Operator seats | 2 | 1 | 10 | unlimited |
| Knowledge chunks | 500 | 2 000 | 25 000 | unlimited |
| Workflows | 1 | 1 | 10 | unlimited |
| API requests / minute | 60 | 120 | 600 | 3 000 |
| Workflows, knowledge base, file uploads | yes | yes | yes | yes |
| AI suggestions | yes | **no** | yes | yes |
| Analytics tier | basic | basic | advanced | advanced |
| Public API access | no | no | yes | yes |
| Custom branding | no | no | yes | yes |
| Priority support | no | no | no | yes |

- **Subscription (`models/subscription.js`):** one per company, lazily created on `trial`; `status trialing|active|past_due|cancelled|suspended`; `trialEndsAt`; `limitOverrides` map (negative = unlimited); `overageAllowed`; Stripe `externalCustomerId/SubscriptionId`; `externalEventAt` ordering guard. `isEntitled()` is false for cancelled/suspended/expired trial; **`past_due` still entitles**. Trial expiry is computed at read time (`effectiveStatus() === 'trial_expired'`); nothing flips the stored status.
- **Metering (`services/usage.js`, `models/usage.js`):** monthly document per company (`YYYY-MM`, UTC — the new month is a new document, no reset job) counting `conversations`, `messages`, `aiResponses`, `operatorMessages`, `filesUploaded`, `fileBytes`, `limitHits`; seats/workflows/chunks are counted live. Only the five `METERS` are limited. `knowledgeChunksIngested` exists on the schema but is never incremented.
- **Enforcement (`middleware/quota.js`):** `enforceLimit(meter)` → 402 `{code:'PLAN_LIMIT_REACHED', meter, limit, used, planId}`; `requireFeature(feature)` → 402 `FEATURE_NOT_IN_PLAN`; superadmin bypass; **fail open** on internal error. Applied to operator creation/reactivation, workflow creation, knowledge import (twice: before fetch and after chunking), conversation creation and AI replies (socket and REST), file uploads, API keys (per request), advanced analytics, and the per-minute rate limiter. `overageAllowed` lets `check()` pass beyond the limit — **nothing bills for it**. `customBranding` and `prioritySupport` are never read anywhere.
- **Stripe (`services/stripe.js`, no SDK, no secret key):** only `POST /api/billing/webhook/stripe`. Signature verified over `req.rawBody` (captured only for `/api/billing/webhook*`), 300 s tolerance, `StripeEvent` idempotency ledger (TTL 30 days), events older than `externalEventAt` ignored. Handles `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_succeeded`, `invoice.payment_failed` (→ `past_due`); price → plan via `STRIPE_PRICE_BASIC/PROFESSIONAL/ENTERPRISE`; tenant via `metadata.companyId` or `client_reference_id` (only if `STRIPE_ALLOW_CLIENT_REFERENCE=true`); unknown price leaves the plan alone. Unrecognised events and unmatched customers are acknowledged with 200. **There is no checkout, portal or upgrade button**; tenants reach Stripe by a Payment Link sent out-of-band.
- **Superadmin:** `PATCH /api/billing/companies/:id/subscription {planId, status, overageAllowed, currentPeriodEnd, limitOverrides, externalCustomerId, externalSubscriptionId}` (audited `plan.changed`), `GET /api/billing/usage` (all tenants), `GET /api/billing/companies/:id`. Same `applySubscriptionChange` function as the webhook.
- **Dashboard Plan & Usage:** catalogue cards, current plan and status, trial countdown, feature list, usage meters with 80/100 % thresholds, limit-hit alert, 12-month history chart; superadmin sees a tenant usage table with a Change-plan modal.

### 2.9 Security and compliance

- **Tenant isolation:** `utils/query.js#companyFilter`/`companyScope` on REST; socket handlers check `canOperateOn(sessionId)` (conversation.company must equal the operator's company; superadmin passes); visitors act only on the session bound by `resume-session`; `join` refuses reserved rooms; per-company CORS from `allowedDomains` + `ALLOWED_DOMAINS` (`server.js#corsPolicy`: a valid widget key admits an unregistered origin without credentials); socket CORS mirrors it.
- **Staff auth:** JWT (8 h, `{id, username, role, company, tv}`) in `x-auth-token` (REST) or handshake `auth.token` (socket); `tokenVersion` bump on logout/password change/reset invalidates all sessions; passwords bcrypt(10), min 8 (12 for superadmin); forgot/reset by SHA-256 token with 1 h expiry via `SMTP_*`. Rate limits (`middleware/rateLimiter.js`, MongoDB-backed so they hold across instances): login per address+account (10/h, failures only) and per address (50/h), password reset 5/h, chat and API per tenant/user with the allowance from the plan; superadmins skipped; in-memory fallback if MongoDB is unreachable.
- **Visitor session tokens (`services/session-token.js`):** 32 random bytes, SHA-256 hash stored on the conversation (`select:false`), required for `resume-session`, `POST /api/chat/*`, and `POST /api/upload`; legacy conversations without a hash are accepted once and upgraded.
- **API keys:** see 2.5; SHA-256 hashed, prefix-indexed, constant-time compare, per-key rate limit, plan-checked per request, revocation immediate, audited.
- **Secrets at rest (`services/secrets.js`):** AES-256-GCM, key from `SECRETS_KEY` else HKDF of `SESSION_SECRET` (warned); encrypted: action-node `auth.value`, `Webhook.secret`, `Company.connector.secret`. **Not encrypted** (only `select:false` or nothing): `Company.identitySecret`, `Company.emailChannel.inboundSecret`, `GoogleToken.accessToken/refreshToken`.
- **Audit log (`services/audit.js`, `models/audit-log.js`):** append-only (no update/delete route), actor copied not joined, secret-looking keys redacted, TTL `AUDIT_RETENTION_DAYS` (400). Actions: `auth.login/logout/password_change/password_reset_requested/password_reset`, `superadmin.created`, `user.created`, `operator.activated/deactivated/updated/role_changed`, `plan.changed` (superadmin and `stripe` system actor), `api_key.created/revoked`, `webhook.created/updated/deleted/secret_rotated`, `workflow.published/rolled_back/deleted`, `knowledge.imported/refreshed/deleted`, `connector.updated`, `identity_secret.rotated`, `company.retention_changed`, `conversation.deleted`, `gdpr.data_read/exported/erased`, `tenant_backup.created/restored`, task `task_deleted`/`deleted`. Read by admins for their company (`GET /api/admin/audit`), platform-level entries by superadmin only. Not audited: company create/update/delete, operator creation, admin password resets, platform backup create/restore.
- **GDPR (`routes/gdpr.js`):** subject resolved by contact email / externalId / sessionId / contact id / legacy `userId`, tenant-scoped; 404 when nothing matches. `GET /export/:id` portable JSON (contacts + conversations with transcript, pre-chat metadata, email headers, rating, workflow answers, attachment names); `GET /user-data/:id` raw; `DELETE /user-data/:id` deletes uploaded files, anonymises task `contactInfo`, deletes matching webhook deliveries, conversations and contacts; all audited. `POST /consent` stores `{marketing, analytics, storage}` on the session/conversation (unused by the widget). `GET /privacy-policy` serves `public/privacy-policy.html`. No dashboard UI for export/erase.
- **Retention (`services/dataRetention.js`, `Company.dataRetention`):** per-tenant `anonymizeAfterDays` and `deleteAfterDays` (0 = never, unset = platform default `RETENTION_ANONYMIZE_DAYS`/`RETENTION_DELETE_DAYS`, both default never); delete before anonymise refused; daily sweep deletes files then conversations, then anonymises (`Conversation.anonymize()` strips transcript, addresses, contact link, notes, workflow variables, rating comment; keeps timings/roles/scores); one tenant's failure does not stop the others; **Settings → Data retention** shows what tonight's run would touch; changes audited. Only conversations are subject to retention.
- **Per-tenant backups (`services/tenant-backup.js`):** EJSON NDJSON per model under `backups/tenants/<companyId>/<timestamp>/` with a manifest listing counts and uncovered collections (`GoogleToken`, `StripeEvent`); tenant-owned models discovered from schemas, dependents (`Comment→Task`, `Notification→User`, `WorkflowVersion→Workflow`, `KnowledgeDocument→User`) declared; uploaded files not included; restore `merge` (upsert) or `replace` (requires typing the company name); a manifest for another company is refused; `AuditLog` and `RateLimitCounter` are exported but never restored. Nightly at 02:30 when `TENANT_BACKUPS_ENABLED`, retention `TENANT_BACKUP_RETENTION_DAYS` (90). Superadmin-only routes, audited, no UI.
- **Uploads (`services/uploads.js`, `routes/upload.js`):** MIME allowlist (client-declared, no sniffing/scanning), `MAX_UPLOAD_BYTES` (10 MB), random 32-hex ids under `uploads/<companyId>/`, downloads as `application/octet-stream` attachment with `nosniff`, visitor (own session) or staff of the owning company; plan feature `fileUploads`; metered.
- **HTTP hardening (`server.js`):** helmet CSP (`script-src 'self' cdn.jsdelivr.net`, no inline script, `frame-ancestors 'self'`), compression, 1 MB body limit, MongoDB-backed session cookie (`httpOnly`, `secure` + `SameSite=None` in production), JSON 404 for `/api`, generic 500s in production, graceful shutdown. Production refuses to start without `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET` (≥32 chars, not defaults) and `OPENAI_API_KEY` (`config/env.js`).

### 2.10 Platform / ops

- **Superadmin tools:** Companies section (create company + admin with generated password, edit, activate/deactivate, users CRUD, reset passwords); plan/overage/limit overrides and cross-tenant usage (Billing); company picker on Knowledge Base; `GET /api/workflow-execution/all-active`; backups via API only (`/api/operations/backups*` whole-database `mongodump`/`mongorestore --drop` when `BACKUPS_ENABLED`, `mongodb-tools` not in the image; `/api/operations/companies/:id/backups*` per-tenant). No impersonation. `DELETE /api/companies/:id` only removes the company document (and only when it has no users); tenant data and files remain (`uploads.purgeCompanyData` has no caller).
- **Health/metrics:** `GET /health` (liveness), `GET /ready` (503 while MongoDB is down), `GET /metrics` (Prometheus via `express-prom-bundle`: request-duration histogram, `chat_messages_total`, process metrics) guarded by `METRICS_TOKEN` (404 in production without one), `GET /api/operations/status` (memory/uptime; `admin` role), `GET /api/workflow-execution/health` (unauthenticated).
- **Alerting (`services/alerting.js`):** email only (`ALERTS_ENABLED`, `EMAIL_ALERTS_ENABLED`, `ALERT_RECIPIENTS`, every `ALERT_CHECK_INTERVAL` ms): `high_response_time` (avg > 2000 ms over the interval, warning) and `high_error_rate` (5xx > 5 %, critical) with resolution mails; memory/cpu/disk thresholds declared but unchecked.
- **Scheduler (`SCHEDULER_ENABLED`, default true; set on exactly one instance):** webhook retries every minute; task deadline sweep midnight + hourly 08–18; per-tenant backups 02:30; retention every 24 h; whole-DB backup every `BACKUP_INTERVAL_HOURS`; alert checks. `REDIS_URL` switches socket.io to the Redis adapter for multi-instance. Logging: winston console + daily-rotated JSON files (`logs/`), `LOG_LEVEL`, query-string redaction of `secret|token|key|reset`.
- **Deployment:** `Dockerfile` (node:20-alpine, non-root, HEALTHCHECK), `docker-compose.yml` (app + mongo:7, optional `redis` profile, volumes for `uploads/` and `backups/`), CI (`.github/workflows/ci.yml`: lint, tests, `npm audit --audit-level=high`, image build). Tests: 48 `*.test.js` files under `tests/` against in-memory MongoDB with `OPENAI_API_KEY` blanked.

---

## 3. API reference summary

Auth legend: **public**; **visitor** (session cookie / `sessionId`+`sessionToken`); **operator** (= operator, company_admin, superadmin); **admin** (= company_admin, superadmin); **admin-own** (admin with a company); **superadmin**; **api-key**; **webhook** (signature/secret); **auth** (any signed-in role). Middleware in `middleware/auth.js` (`auth`, `operator`, `admin`, `superadmin`), `middleware/quota.js`, `middleware/api-key.js`.

Mounts (`server.js`): `/api/v1` public-api (own limiter, mounted before the general one); `/api/chat` (chat limiter); `/api` (general limiter); then admin, auth, gdpr, operations, google, tasks, companies, workflows, webhooks, workflow-execution, notifications, widget, upload, billing, templates, knowledge, contacts, email, api-keys. Inline: `GET /health`, `GET /ready`, `GET /metrics`, `GET /` → `/admin/`, hashed widget assets, static `public/`.

### `routes/auth.js` — `/api/auth`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/login` | public (rate-limited) | Issue 8 h JWT; every outcome audited |
| POST | `/logout` | auth | Bump `tokenVersion` |
| POST | `/change-password` | auth | Requires current password; returns new token |
| POST | `/forgot-password` | public | Always 200; emails reset link via `SMTP_*` |
| POST | `/reset-password` | public | Consume token |
| POST | `/register` | admin + `enforceLimit('operators')` | Create user (company_admin: operators in own company only) |
| POST | `/create-superadmin` | public while no users exist | Bootstrap |
| GET | `/verify` | token | Validate token, return user |

### `routes/admin.js` — `/api/admin` (all `auth`+`operator`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/active-chats` | operator | Active conversations (≤200) |
| GET | `/chat-history` | operator | Paginated search |
| GET | `/chat/:sessionId` | operator | Full conversation |
| POST | `/chat/:sessionId/contact-info` | operator | Set name/email/phone |
| PUT | `/chat/:sessionId/tags` | operator | Replace tags; webhook `conversation.tagged` |
| GET | `/tags` | operator | Known tags |
| PUT | `/me/availability` | operator | `acceptingChats`, `maxConcurrentChats` |
| POST | `/chat/:sessionId/claim` | operator | Atomic claim (409 if held) |
| POST | `/chat/:sessionId/notes` | operator | Add internal note |
| DELETE | `/chat/:sessionId/notes/:noteId` | operator (author or admin) | Delete note |
| POST | `/chat/:sessionId/transfer` | operator | Transfer with note |
| DELETE | `/chat/:sessionId` | operator | Delete conversation (audited) |
| POST | `/chat/:sessionId/end` | operator | End; CSAT; webhook |
| GET | `/analytics` | operator | Basic analytics |
| GET | `/analytics/advanced` | operator, plan advanced | Advanced report (`days`) |
| GET | `/export` | operator | CSV (`type=conversations`) |
| GET | `/audit`, `/audit/actions` | admin | Audit search / distinct actions |
| GET | `/operators`, `/all-operators` | operator | Operator lists |
| POST | `/operators` | admin + seat quota | Create operator |
| PATCH | `/operators/:id` | admin | Toggle `isActive` (seat re-check) |
| PUT | `/operators/:id` | admin | Update allow-listed fields (audited) |
| POST | `/operators/:id/reset-password` | admin | Set password, bump tokenVersion |

### `routes/chat.js` — `/api/chat`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/history` | visitor | Messages for session |
| POST | `/message` | visitor | REST fallback: create conversation (quota), resolve contact, workflow/assistant reply (quota) |

### `routes/widget.js` — `/api/widget`
| GET | `/config` | public | Tenant presentation settings, availability, hashed asset paths |

### `routes/upload.js` — `/api/upload`
| POST | `/` | visitor (existing conversation + token) | Upload one file (plan `fileUploads`) |
| GET | `/:fileId` | visitor (own session) or staff of owning company | Download |

### `routes/company.js` — `/api/companies` (all `auth`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | superadmin | List companies |
| GET/PUT | `/me/widget` | admin-own | Widget key, allowed domains, `widgetSettings` |
| POST | `/me/widget/rotate-key` | admin-own | Rotate widget key |
| GET/PUT | `/me/hours` | admin-own | Business hours |
| GET/PUT | `/me/retention` | admin-own | Retention policy (audited) |
| GET/PUT | `/me/connector` | admin-own | Connector URL/enabled/secret |
| POST | `/me/connector/check` | admin-own | Discovery |
| GET/PUT | `/me/routing` | admin-own | autoAssign / assignOnStart / maxConcurrent |
| GET/PUT | `/me/email` | admin-own | Email channel settings |
| GET | `/:id` | superadmin or own company | Company |
| POST | `/` | superadmin | Create company + admin |
| PUT | `/:id` | superadmin or that company's admin | Update (`isActive` superadmin only) |
| DELETE | `/:id` | superadmin | Delete if no users |
| GET | `/:id/users` | superadmin or own company | Users |
| GET/PUT | `/:id/admin` | superadmin | Company admin |
| POST | `/:id/admin/reset-password` | superadmin | Reset |
| POST | `/:id/users` | superadmin + seat quota | Create user |
| GET/PUT | `/:id/users/:userId` | superadmin | User |
| POST | `/:id/users/:userId/reset-password` | superadmin | Reset |
| PATCH | `/:id/users/:userId/status` | superadmin | Set `isActive` |

### `routes/contacts.js` — `/api/contacts` (`auth`+`operator`)
| GET | `/` | operator | Search/list (`search`, `tag`, `verified`, paging) |
| GET | `/:id` | operator | Contact + last 50 conversations |
| PUT | `/:id` | operator | Edit name/email/phone/tags/attributes |
| POST | `/:id/merge` | operator | Merge `sourceId` into `:id` |
| GET | `/identity/secret` | admin-own | Identity HMAC secret + examples |
| POST | `/identity/secret/rotate` | admin-own | Rotate (audited) |

### `routes/task.js` — `/api/tasks` (`auth`+`operator`)
| GET | `/` | List/filter/search |
| GET/PUT/DELETE | `/:id` | Read/update/delete |
| POST | `/` | Create |
| POST | `/:id/assign` | Assign |
| GET/POST | `/:id/comments` | Comments |
| PUT/DELETE | `/:id/comments/:commentId` | Edit/delete own comment |
| GET/POST | `/:id/follow-ups` | Follow-up tasks |
| GET | `/:id/activities` | Activity log |

### `routes/notification.js` — `/api/notifications`
| GET | `/` | operator | Own notifications |
| PUT | `/:id/read`, `/read-all` | operator | Mark read |
| DELETE | `/:id` | operator | Delete |
| POST | `/check-deadlines` | admin | Run deadline sweep |

### `routes/templates.js` — `/api/templates` (canned replies + persona)
| GET | `/mine` | operator | Enabled templates for the composer |
| GET/POST | `/` | admin | List / create |
| PUT/DELETE | `/:id` | admin | Update / delete |
| POST | `/preview` | admin | Semantic match test |
| GET/PUT | `/assistant/config` | admin | Persona and scope |

### `routes/knowledge.js` — `/api/knowledge`
| GET | `/` | admin | Stats + sources (`companyId` for superadmin) |
| POST | `/sources` | admin + `knowledgeBase` + chunk quota | Import `{url}` (page/PDF) or `{text,title}` |
| POST | `/sources/:sourceId/refresh` | admin | Re-fetch url/pdf source |
| POST | `/search` | admin | Vector search test |
| DELETE | `/sources/:sourceId` | admin | Remove source |

### `routes/google.js` — `/api/google`
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
| GET | `/` | List (`status`) |
| GET | `/templates`, `/templates/:id` | Workflow templates |
| GET | `/:id` | One (credentials redacted) |
| POST | `/` (+ `workflows` feature and limit) | Create |
| PUT | `/:id` | Update |
| POST | `/:id/publish` | Publish + hot swap (audited) |
| POST | `/:id/archive` | Archive |
| GET | `/:id/versions` | Version history |
| POST | `/:id/rollback/:version` | Rollback (audited) |
| DELETE | `/:id` | Delete draft/archived (audited) |
| GET | `/active/current` (any auth role) | Active workflow |
| POST | `/validate` | Validate graph |
| POST | `/actions/test` | Run one action node |
| POST | `/preview` | Simulate a graph |
| GET | `/:id/stats` | `executionStats` (always zeros; never written) |

### `routes/workflow-execution.js` — `/api/workflow-execution`
| POST | `/execute` | auth | Run tenant's published workflow |
| GET | `/status` | admin | Runtime status |
| GET | `/all-active` | superadmin | All loaded workflows |
| POST | `/reload` | admin | Force-load a workflow |
| GET | `/health` | public | Runtime health |

### `routes/webhooks.js` — `/api/webhooks` (`auth`+`admin`)
| GET | `/events` | Event catalogue |
| GET | `/deliveries` | Delivery log |
| GET/POST | `/` | List / create (secret shown once) |
| PUT | `/:id` | Update/enable |
| POST | `/:id/rotate-secret` | Rotate |
| POST | `/:id/test` | Send test |
| DELETE | `/:id` | Delete |

### `routes/billing.js` — `/api/billing`
| GET | `/plans` | public | Catalogue |
| GET | `/me`, `/me/history` | admin | Own plan/usage |
| PATCH | `/companies/:companyId/subscription` | superadmin | Change plan/overage/overrides |
| POST | `/webhook/stripe` | webhook (Stripe signature) | Apply Stripe events |
| GET | `/companies/:companyId`, `/usage` | superadmin | Tenant summary / all usage |

### `routes/api-keys.js` — `/api/api-keys` (admin-own)
| GET | `/` | List + scopes + `enabled` |
| POST | `/` (plan `apiAccess`) | Create (key shown once) |
| DELETE | `/:id` | Revoke |

### `routes/public-api.js` — `/api/v1` (api-key)
| GET | `/me` | Key info |
| GET | `/conversations`, `/conversations/:sessionId` | scope `conversations:read` |
| GET | `/contacts` | scope `contacts:read` |
| GET | `/tasks` | scope `tasks:read` |

### `routes/email.js` — `/api/email`
| POST | `/inbound/:companyId/:provider?` | webhook (inbound secret) | Inbound mail → conversation |

### `routes/gdpr.js` — `/api/gdpr`
| GET | `/user-data/:userId` | admin | Raw subject data (audited) |
| DELETE | `/user-data/:userId` | admin | Erase (audited) |
| GET | `/export/:userId` | admin | Portable export (audited) |
| GET | `/privacy-policy` | public | Static page |
| POST | `/consent` | visitor | Store consent |

### `routes/operations.js` — `/api/operations`
| GET | `/status` | admin | Process status |
| GET/POST | `/backups`, `/backups/create`, `/backups/restore` | superadmin | Whole-DB backups |
| GET/POST | `/companies/:companyId/backups`, `…/backups/:timestamp/restore` | superadmin | Per-tenant backups (audited) |

### Socket events (`websockets.js`, `socketManager.js`; single namespace; rooms `operators:<companyId>`, `operators:all`, `user:<userId>`, `<sessionId>`)

Authentication: operators pass the JWT in handshake `auth.token` (invalid/expired → treated as visitor; inactive user → refused); visitors bind a session with `resume-session` + session token. No ack callbacks; replies are events.

**Client → server**
| Event | Emitter | Payload | Effect |
|---|---|---|---|
| `resume-session` | visitor | `sessionId`, `sessionToken?`, `widgetKey`, `externalId`, `userHash`, `pageUrl`, `email/name/phone` | Verify/issue token, create conversation (quota), bind, join room → `session-ready`, `session-history` or `session-rejected` |
| `user-message` | visitor | `message`, `messageId`, `timestamp`, `userName?` | Save, notify operators, then suggestion (if operator) or automatic answer |
| `user-details` | visitor | `name`, `email`, `phone`, `externalId?`, `userHash?` | Store metadata, resolve/link contact → `user-details-updated` |
| `chat-opened` | visitor | — | `chat-activity {opened}` to operators |
| `user-typing` | visitor | `isTyping` | Relay to operators |
| `file-uploaded` | visitor | `fileId`, `fileName` | Record message, notify operators |
| `message-read` / `mark-all-read` | visitor | `messageId` | Relay receipts to operators |
| `request-operator` | visitor | — | Queue + auto-assign → `operator-requested` |
| `submit-rating` / `decline-rating` | visitor | `score`, `comment?` | CSAT record → `rating-recorded`; `conversation-rated` to operators |
| `heartbeat` | any | — | `heartbeat-ack`, re-join operator room |
| `join` | any | `sessionId` | Join a room (visitor: own only; operator: same company) → `joined-room` |
| `join-operator-room` | operator | — | Join company (or global) room |
| `operator-takeover` | operator | `sessionId`, `force?` | Claim chat; `operator-joined`; forced → `chat-taken-from-you` |
| `operator-message` | operator | `sessionId`, `message` | Deliver (email channel sends mail) |
| `operator-typing` | operator | `sessionId`, `isTyping` | Relay to visitor |
| `request-suggestions` | operator | `sessionId`, `messageId?` | AI draft → `operator-suggestion` |
| `use-suggestion` | operator | `sessionId`, `suggestion`, `edited?` | Send it; `suggestion-used` |
| `toggle-suggestions` | operator | `sessionId`, `enabled` | Per-chat toggle → `suggestions-toggled`, `suggestions-status-changed` |
| `request-user-details` | operator | `sessionId` | Widget shows pre-chat form |
| `operator-leave` | operator | `sessionId`, `passToBot` | Release to bot or re-queue → `operator-left` |
| `end-chat` | operator | `sessionId` | End; CSAT; webhook → `chat-ended` |
| `disconnect` | built-in | — | Visitor: `chat-activity {closed}`; operator: grace timer then release |

**Server → client**
| Event | To | Purpose |
|---|---|---|
| `session-ready`, `session-history`, `session-rejected` | visitor | Session binding / replay (last 50) |
| `bot-message` (`text`, `choices?`, `cards?`), `bot-typing` | visitor / room | Bot reply |
| `operator-message`, `operator-typing`, `request-user-details`, `chat-ended {message, requestRating}`, `chat-transferred`, `operator-requested {queued, connected, operatorName}`, `message-read`, `rating-recorded`, `heartbeat-ack`, `joined-room`, `error` | visitor | Conversation lifecycle |
| `new-chat`, `new-message`, `chat-activity`, `chat-reactivated`, `user-typing`, `all-messages-read`, `message-read`, `user-details-updated`, `operator-joined`, `operator-left`, `chat-ended`, `operator-requested`, `chat-assigned`, `conversation-tagged`, `conversation-note`, `conversation-rated`, `suggestion-used`, `suggestions-status-changed`, `workflow:published`, `workflow:hot-swap`, `workflow:unloaded` | `operators:<companyId>` (+ `operators:all`) | Queue and inbox updates |
| `chat-assigned-to-you`, `chat-transferred-to-you`, `chat-taken-from-you`, `operator-suggestion`, `suggestions-toggled`, `notification-created`, `notification-updated`, `notifications-all-read`, `notification-deleted` | `user:<operatorId>` | Personal nudges |
| `task-created/updated/deleted/assigned`, `comment-created/updated/deleted` | company room | Task board |

---

## 4. Data model summary (`models/`)

| Collection (model) | Purpose | Key fields |
|---|---|---|
| `companies` (Company) | The tenant | `name` (unique), `widgetKey` (`wk_…`, unique), `allowedDomains[]`, `identitySecret` (select:false), `assistant {persona, scope}`, `emailChannel {enabled, inboundAddress, fromName, fromAddress, inboundSecret, signature}`, `businessHours {enabled, timezone, days[{day, opensAt, closesAt, closed}], offlineMessage}`, `connector {enabled, url, secret (encrypted), capabilities[], sdkVersion, lastCheckedAt, lastError}`, `routing {autoAssign, maxConcurrent 1–20 (3), assignOnStart}`, `dataRetention {anonymizeAfterDays, deleteAfterDays, updatedAt, updatedBy}`, `widgetSettings` (see §5), `isActive`, `createdBy` |
| `users` (User) | Staff | `username`, `email` (unique), `password` (bcrypt), `role superadmin\|company_admin\|operator`, `company` (required for non-superadmin), `displayName`, `name`, `isActive`, `tokenVersion`, `passwordResetTokenHash/Expires`, `maxConcurrentChats`, `acceptingChats`, `lastLogin` |
| `subscriptions` (Subscription) | Plan choice per company | `company` (unique), `planId`, `status trialing\|active\|past_due\|cancelled\|suspended`, `currentPeriodEnd`, `trialEndsAt`, `limitOverrides` map, `overageAllowed`, `externalCustomerId/SubscriptionId`, `externalEventAt` |
| `usages` (Usage) | Monthly meters | `company`+`period YYYY-MM` (unique), `conversations`, `messages`, `aiResponses`, `operatorMessages`, `filesUploaded`, `fileBytes`, `knowledgeChunksIngested` (never written), `limitHits` |
| `conversations` (Conversation) | A chat or email thread | `sessionId` (unique), `sessionTokenHash`, `channel chat\|email`, `email {subject, from, to, messageIds[], lastMessageId}`, `messages[] {content, sender user\|bot\|operator, messageId, isRead, fileId, fileName, operatorId, operatorName, emailMessageId, attachments[], timestamp}`, `status active\|ended\|archived`, `hasOperator`, `operatorId/Name`, `suggestionsEnabled`, `botEnabled`, `metadata` map (name/email/phone/consent), `tasks[]`, `notes[] {body, author, authorName, system, createdAt}`, `transferredFrom`, `tags[]`, `assignment {method auto\|manual, at}`, `awaitingOperatorSince`, `workflowState {workflowId, version, awaiting, variables, updatedAt}`, `rating {score 1–5, comment, ratedAt, operatorId/Name, handledBy bot\|operator}`, `ratingRequestedAt`, `startedAt`, `endedAt`, `lastActivity`, `company`, `contact`, `anonymizedAt`, legacy `userId`, `domain` |
| `contacts` (Contact) | A person across sessions | `company`, `externalId` (unique per company when set), `identityLevel anonymous\|claimed\|verified`, `email`, `phone`, `name`, `sessionIds[]`, `attributes` map, `tags[]`, `conversationCount`, `firstSeenAt`, `lastSeenAt` |
| `tasks` (Task) | Follow-up work | `title`, `description`, `dueDate`, `priority low\|medium\|high\|urgent`, `assignee`, `assigneeName`, `status open\|in_progress\|completed`, `conversationId`, `parentTaskId`, `contactInfo {name, phone, email}`, `createdBy`, `createdByBot`, `company`, `completedAt` |
| `comments` (Comment) | Task comments | `taskId`, `content`, `author`, `authorName`, `isEdited`, `attachments[]` (no `company`) |
| `activities` (Activity) | Task activity feed | `taskId`, `type` (13 task/comment events), `user`, `userName`, `description`, `metadata`, `changes {field, oldValue, newValue}`, `company` |
| `notifications` (Notification) | Task deadline alerts | `type task_due_tomorrow\|task_due_today\|task_overdue`, `taskId`, `userId`, `read`, `message`; TTL 30 days |
| `responsetemplates` (ResponseTemplate) | Canned replies | `company`, `name`, `role greeting\|fallback\|offTopic\|handoff\|null`, `triggers[]`, `responses[]`, `variables` map, `threshold`, `enabled`, `useCount`, `lastUsedAt` |
| `knowledgechunks` (KnowledgeChunk) | Embedded knowledge | `company`, `sourceId`, `sourceType google_sheets\|pdf\|url\|upload\|manual`, `importId`, `collectionName`, `content`, `embedding[]`, `embeddingSignature`, `metadata`, `chunkIndex` |
| `knowledgedocuments` (KnowledgeDocument) | Google Sheets import (unread by assistant) | `userId`, `spreadsheetId`, `sheet`, `title`, `columns[{name, description, exclude}]`, `rows[][]` |
| `googletokens` (GoogleToken) | Per-user OAuth tokens (plaintext) | `userId` (unique), `accessToken`, `refreshToken`, `scope`, `tokenType`, `expiryDate` |
| `workflows` (Workflow) | Visual flow | `name`, `description`, `version`, `status draft\|published\|archived`, `nodes[] {id, type, position, data}`, `edges[] {id, source, target, sourceHandle, targetHandle}`, `compiledChain`, `company`, `rootSystemPrompt`, `moderationConfig`, `createdBy`, `publishedAt`, `executionStats` (never written) |
| `workflowversions` (WorkflowVersion) | Version snapshots | `workflowId`, `version`, `nodes`, `edges`, `compiledChain`, `changeDescription`, `isRollback`, `rollbackFromVersion`, `performanceMetrics`, `createdBy` |
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
| `data-user-id` | none | Tenant-signed visitor id |
| `data-user-hash` | none | `HMAC-SHA256(identitySecret, userId)` hex |
| `data-chatbot-name` | server / `Assistant` | Header title |
| `data-primary-color` | server / `#2196f3` | `--primary-color` |
| `data-position` | server / `right` | `left` or `right` |
| `data-initial-message` | server `welcomeMessage` / `Hello! How can I assist you today?` | Greeting |
| `data-privacy-policy-url` | `<serverUrl>/privacy-policy.html` | Pre-chat form link |
| `data-require-name` / `data-require-email` / `data-require-phone` | server `true/true/false` | Mandatory pre-chat fields |

### `Company.widgetSettings` (`models/company.js`, edited under Channels → Website widget)
`chatbotName` ('Assistant'), `primaryColor` ('#2196f3'), `position` (`left|right`), `welcomeMessage` ('Hi! How can we help you today?'), `logoUrl` (accepted, not rendered), `requireName` (true), `requireEmail` (true), `requirePhone` (false), `privacyPolicyUrl` (http(s) only). Also per company: `allowedDomains`, `widgetKey` (rotatable), `businessHours`, `emailChannel`, `routing`, `dataRetention`, `assistant`, `connector`, `identitySecret`.

### Environment variables (names only; from `.env.example` and `process.env` reads)
- **Core:** `NODE_ENV`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY`, `LOG_LEVEL`, `ALLOWED_DOMAINS`
- **Database:** `MONGODB_URI`, `MONGO_POOL_SIZE`, `MONGODB_TEST_URI` (tests)
- **Secrets:** `JWT_SECRET`, `SESSION_SECRET`, `SECRETS_KEY`
- **AI:** `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CLASSIFIER_MODEL`, `OPENAI_TIMEOUT_MS`, `EMBEDDING_MODEL`
- **Knowledge / vectors:** `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `MONGODB_VECTOR_INDEX`, `VECTOR_SCAN_LIMIT`, `MAX_PDF_BYTES`, `MAX_PAGE_BYTES`
- **Uploads:** `MAX_UPLOAD_BYTES`
- **Scale / runtime:** `REDIS_URL`, `SCHEDULER_ENABLED`, `OPERATOR_GRACE_MS`, `WORKFLOW_CACHE_TTL_MS`
- **Rate limits:** `RATE_LIMIT_API_MAX`, `RATE_LIMIT_CHAT_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_IP_MAX`, `RATE_LIMIT_PASSWORD_RESET_MAX`
- **Retention:** `RETENTION_ANONYMIZE_DAYS`, `RETENTION_DELETE_DAYS`, `ARCHIVED_RETENTION_DAYS` (legacy), `AUDIT_RETENTION_DAYS`, `WEBHOOK_LOG_RETENTION_DAYS`
- **Backups:** `BACKUPS_ENABLED`, `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS`, `TENANT_BACKUPS_ENABLED`, `TENANT_BACKUP_RETENTION_DAYS`
- **Monitoring / alerting:** `METRICS_TOKEN`, `ALERTS_ENABLED`, `EMAIL_ALERTS_ENABLED`, `ALERT_RECIPIENTS`, `ALERT_CHECK_INTERVAL`, `ALERT_FROM_EMAIL`
- **Platform mail:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- **Email channel (outbound):** `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`
- **Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`
- **Outbound HTTP:** `ACTIONS_ALLOW_HTTP`, `ACTIONS_USER_AGENT`, `WEBHOOK_USER_AGENT`
- **Billing:** `TRIAL_DAYS`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_ENTERPRISE`, `STRIPE_ALLOW_CLIENT_REFERENCE`
- **Connector SDK (tenant side):** `CHATBOT_CONNECTOR_SECRET`

---

## 6. Known gaps

**From `todo.md` / `IMPLEMENTATION_STATUS.md` (owner-acknowledged):**
- Overage is honoured by the quota check but never billed; no invoicing, reminders, revenue/churn reporting.
- Nothing starts a Stripe Checkout from inside the product (no upgrade button, no SDK, no portal); tenants pay via an externally sent Payment Link.
- `prioritySupport` (and `customBranding`) are plan flags nothing reads; no SLA/priority queue.
- Enterprise analytics (predictive, segmentation, ROI, benchmarking) unbuilt; topic analysis is term frequency (no synonym grouping).
- Google Sheets knowledge documents are stored but not read by the assistant (see §2.5).
- No operator invite flow: admins set passwords directly.
- The assistant cannot choose a connector capability itself; only a workflow node invokes one. Order lookup is not a capability yet (contract covers catalogue and appointments only).
- Operator-side attachments: visitors can upload, operators cannot, and the operator transcript never renders `fileUrl`.
- No loops in workflows (any cycle is a validation error); no sub-workflow calls.
- Republishing a workflow does not invalidate in-flight conversations' node ids (the reply seam restarts state only when the id/version differs).
- Untested: `services/backup.js` (mongodump path), `services/scheduler.js`.
- Housekeeping: express 4 → 5, eslint 8 → 9, 9 moderate transitive advisories (`qs`, `uuid` via `googleapis`), `googleapis` far behind, dashboard loads 23 unbundled scripts with unpinned socket.io and no SRI on some CDN tags.
- Scanned PDFs yield no text (no OCR); in-process vector ranking scans all chunks (warns above 20 000); intent matching is lexical without an OpenAI key.

**Noticed in the code during this pass (not in todo.md):**
- **Canned-reply save is broken in the UI:** `public/js/admin_parts/admin-assistant.js:220` calls `api(id ? \`/${id}\` : '', …)` instead of `/api/templates[/id]`, so creating or editing a canned reply from the Assistant section cannot succeed (delete and preview use the right paths).
- `knowledge-connector.js#loadGoogleSheets` uses the google-spreadsheet v3 API (`useServiceAccountAuth`) against the installed v4.1.4; the workflow editor still offers `google_sheets` as a knowledge source type. `upload` is a chunk `sourceType` with no producer; no file-upload knowledge import exists (URL/PDF-by-URL/text only); no knowledge re-sync scheduling.
- `conversation.started` is in the webhook event catalogue but is never dispatched; `conversation.ended` fires only for operator-ended chats; `task.created` fires only from the workflow node, not from tasks created in the dashboard.
- `Workflow.executionStats` is never persisted (stats live in an in-memory map), so `GET /api/workflows/:id/stats` always returns zeros; `WorkflowVersion.performanceMetrics.compilationTime/validationTime` are never set; `moderation.customFilters` are compiled but never evaluated; `knowledge.vectorCollections` is always empty; compiler validation message still says "Only Router and Action nodes can branch".
- Response-template roles `fallback` and `handoff` are stored but never consumed by `services/ai.js`.
- `Usage.knowledgeChunksIngested` is never incremented; `messages`, `operatorMessages`, `fileBytes` are counted but not limited or billed.
- Plaintext secrets: `Company.identitySecret`, `Company.emailChannel.inboundSecret` (select:false only) and `GoogleToken` access/refresh tokens (no protection at all). `SECRETS_KEY` is read by `services/secrets.js` and documented in the README but its absence silently falls back to a `SESSION_SECRET`-derived key.
- Inbound email trusts only the shared secret; SendGrid/Mailgun/Postmark signatures are not verified. The email router's 10 MB body parsers sit behind the global 1 MB parser, so the larger limit is unreachable.
- Audit coverage gaps: company create/update/delete, operator creation, admin-initiated password resets, whole-DB backup create/restore, superadmin user edits in `routes/company.js` write no audit entries.
- `DELETE /api/companies/:id` removes only the company document; conversations, contacts, chunks, subscription and uploaded files are left behind (`uploads.purgeCompanyData` has no caller).
- Tenant-scoping gaps: `TaskService.assignTask` and `CommentService.getCommentsByTaskId/update/delete` are not company-scoped (routes partially compensate); `PATCH /api/companies/:id/users/:userId/status` skips the seat quota on reactivation.
- Transfer is load-then-save (not atomic) and does not touch `botEnabled`; the waiting queue has no timeout or re-sweep when nobody is available; `availability.offlineMessage` is only reported, never injected into a conversation server-side.
- `GET /api/workflow-execution/health` is unauthenticated; `POST /api/workflow-execution/reload` loads any status (draft/archived) into the live runtime; users without a company key the runtime on their user id.
- `GET /api/operations/status` is available to company admins, not only superadmins.
- Notification TTL expires all notifications after 30 days (comment says "read" only); deadline sweeps use server-local time, not the company timezone; `task_unassigned`, `comment_updated`, `comment_deleted` activity types are never written and `logTaskAssigned`/`logFollowUpCreated` are never called.
- Dashboard: Settings tabs (Routing, Your data, Knowledge, Retention, API keys) are not role-gated and error for operators; `admin-data-controls.js` returns early for superadmins, so they see empty Retention/API-key panes; `suggestion-used` "Used by" note can never match (local ids); new-chat sound is a log stub; opening a conversation from History/People/Tasks renders a reduced view without contact info, rating, tags or notes; `logoUrl` has no upload field and is never rendered.
- Server routes with no UI: claim, end (REST), contact merge, task assign/follow-up creation, comment edit/delete, company delete, company-admin routes, backups, GDPR export/erase, workflow stats/archive/active, workflow-execution routes, `check-deadlines`, consent.
- Widget: no JS API beyond `init`, no i18n, no consent call, no transcript email; identity only through script attributes.
- Connector SDK is unpublished (`@chatbot-platform/connector-sdk` 0.1.0 in-repo only); replay protection is window-only (no nonce) for both connector and webhook signatures.
- `middleware/auth.js` exports `companyAdmin` and `sameCompany` that no route uses; `Authorization: Bearer <jwt>` is honoured by the rate limiter but not by `auth`, so a bearer JWT is limited as a tenant yet rejected as unauthenticated.
- `MongoRateLimitStore.resetKey()` ("unblock a tenant") has no route or scheduled caller.
- Retention covers conversations only; contacts, tasks and knowledge chunks never expire.
