# Chatbot Platform

Multi-tenant customer-support chat: an embeddable widget, an operator
dashboard that installs as an app, an AI assistant that answers from each
tenant's own knowledge base and acts in their systems, and a visual workflow
editor. Conversations arrive from the website, email, WhatsApp, Messenger and
Instagram into one inbox. Node.js, Express, MongoDB, socket.io.

What is built and what is not is in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
and [todo.md](todo.md). Step-by-step setup of every third-party integration
(push keys, Google Calendar, Stripe meters, Meta, Cal.com, Calendly,
WordPress, Shopify, MCP) is in
[docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md).

---

## 1. Prerequisites

- **Node.js 20** or later (the Docker image uses 20)
- **npm**
- **MongoDB 6+**, local or remote. `docker compose up mongodb` starts one
  (see [docs/DOCKER.md](docs/DOCKER.md)).
- An **OpenAI API key**. Optional in development; required in production.

---

## 2. Installation

```sh
git clone <your-repo-url>
cd chatbot-platform
npm install
cp .env.example .env     # then edit it
npm start
```

`npm start` builds the dashboard first (see below); `npm run dev` rebuilds it
and restarts the server on file changes. The server listens on `PORT`
(default 3000); the dashboard is at `/admin`, sign-up at
`/admin/signup.html`.

### The dashboard is built

The dashboard, the sign-in, sign-up and invitation pages and the workflow
editor are ES modules under `client/`, bundled with their libraries
(Bootstrap, Chart.js, Feather, marked) into `public/dist/` by `npm run build`
(`scripts/build-client.js`, esbuild).
`public/dist/` is generated and not committed. Nothing is loaded from a CDN,
so the Content-Security-Policy allows no third-party origin. The Docker image
builds the bundle in its own stage; CI builds it before the tests. The widget
is not bundled: it ships as plain scripts because it runs on customers' sites.
Nor is the operator app's service worker (`public/admin/sw.js`), which the
browser fetches and updates at a fixed URL on its own schedule; its icons in
`public/admin/icons/` are committed and redrawn with
`node scripts/generate-app-icons.js`.

---

## 3. Configuration

Everything is configured through environment variables, read from `.env` in
development or from the environment in deployment. [`.env.example`](.env.example)
lists every key the code reads, grouped and commented; the important ones are
below.

### Required

| Key | What it is |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string. |
| `JWT_SECRET` | Signs auth tokens. Production: required, 32+ characters, not the built-in development value. |
| `SESSION_SECRET` | Signs the session cookie. Same rules. |
| `OPENAI_API_KEY` | **Required in production.** Without a model the bot cannot answer anything a workflow does not script, so a production deployment without it is broken rather than degraded. |

Generate secrets with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The server refuses to start in production (`NODE_ENV=production`) if any of
the first three is missing, too short, or still the development default, or if
`OPENAI_API_KEY` is unset.

### Strongly recommended in production

| Key | What it is |
| --- | --- |
| `PUBLIC_URL` | The address customers reach you at. Used in the links in password-reset, confirmation and invitation emails, the embed snippet, Google sign-in's and Google Calendar's redirects, the email channel's inbound URL, the WhatsApp/Messenger/Instagram callback URLs and the plugin downloads. Must be `https://` for Meta's webhooks. |
| `TRUST_PROXY` | Number of reverse proxies in front of the app (usually `1`), so secure cookies and rate limiting see the real client address. Defaults to `1` in production. |
| `ALLOWED_DOMAINS` | Origins allowed to load the widget in addition to those each tenant registers. No wildcards. |
| `METRICS_TOKEN` | Bearer token a Prometheus scraper must send. In production `/metrics` is only exposed when this is set. |
| `SECRETS_KEY` | Encrypts every credential tenants store: action and connector secrets, webhook secrets, Meta tokens and app secrets, Cal.com and Calendly keys, Google Calendar tokens, MCP server credentials. Without it the key is derived from `SESSION_SECRET`, so rotating that would make all of them unreadable. |

### Running more than one instance

| Key | What it is |
| --- | --- |
| `REDIS_URL` | Switches socket.io to the Redis adapter so an operator on one instance can reach a visitor on another. Required from the second instance on. |
| `SCHEDULER_ENABLED` | Background jobs run wherever this is `true` (the default): webhook retries and the long-wait alert (every minute), booking reminders (every 15 minutes), idle close (hourly at :05), the weekly knowledge refresh (:15), usage warnings (:45), task deadlines, the nightly resolution count (01:15) and Stripe report (01:30), tenant backups, retention and alerting. Set it to `true` on exactly one instance and `false` on the rest. Metrics collection and `/metrics` are unaffected. |
| `OPERATOR_GRACE_MS` | How long a conversation waits for its operator to reconnect before returning to the queue (default 60000). |
| `WORKFLOW_CACHE_TTL_MS` | How long an instance keeps a tenant's published workflows before checking for newer ones (default 30000). |
| `WORKFLOW_PICK_THRESHOLD`, `WORKFLOW_PICK_TIMEOUT_MS` | Choosing which live workflow takes a message by what the visitor wants: how sure the classifier must be (0.45) and how long it may take before the assistant answers instead (4000 ms). |
| `WORKFLOW_STATS_FLUSH_MS` | Workflow run counts are written at most this often (30000). |

### Conversations and limits

| Key | What it is |
| --- | --- |
| `IDLE_CLOSE_HOURS` | A web chat nobody has written in for this many hours, and no operator holds, is ended (default 24), so it leaves the queue, counts as finished in reports and fires `conversation.ended` with `endedBy: 'idle'`. Email and messaging-app threads are never closed this way. |
| `RATE_LIMIT_DASHBOARD_MIN` | A signed-in dashboard user gets at least this many requests a minute (default 300), even on a plan whose `apiRequestsPerMinute` is lower: loading Home is about a dozen requests. API keys (`/api/v1`) still get the plan's number. |
| `VERIFY_EMAIL_HOURLY_LIMIT` | In-chat email verification codes one company may send per hour (default 200). |

### Integrations (all optional)

Each of these is off until configured, and the dashboard says so rather than
offering a button that fails. Step-by-step setup is in
[docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md).

| Key | What it is |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Push notifications to operators' phones and desktops. Generate once with `node scripts/generate-vapid-keys.js ops@yourcompany.com`; all three or push stays off. Needs the `web-push` package (a dependency). Keep the private key as secret as `JWT_SECRET` and do not rotate it casually: devices subscribed under the old key go quiet until their owners reopen the dashboard. |
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI` | The OAuth client tenants connect Google Calendar with (scopes `calendar.events` and `calendar.readonly`). Falls back to `GOOGLE_CLIENT_ID`/`_SECRET`; the redirect defaults to `PUBLIC_URL` + `/api/booking/google/callback` and must be registered exactly. Cal.com and Calendly need nothing here: tenants paste their own key. |

WhatsApp, Messenger and Instagram need no platform keys: each tenant connects
its own Meta app under **Channels**, and Meta calls
`PUBLIC_URL/api/channels/webhook/<provider>`, which must be HTTPS with a valid
certificate. MCP servers, the WordPress plugin and the Shopify snippet need no
platform keys either. The in-chat email code and booking reminders are sent
through the email channel's `EMAIL_*` server (below).

### Accounts, sign-up and sessions

| Key | What it is |
| --- | --- |
| `PRODUCT_NAME` | The name on the sign-in, sign-up and invitation pages, the dashboard's browser tab, the installed operator app, and the account emails (confirmation, invitations, usage warnings). Default "Support Desk". The email channel uses it too (see below). An agency on a plan with custom branding replaces it with its own for its clients. |
| `SIGNUP_ENABLED` | Self-serve sign-up at `/admin/signup.html`. On unless set to `false`; off, the page and `POST /api/auth/signup` refuse and customers join only by invitation. |
| `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | "Sign in with Google" for people who **already have** an account; nobody gets an account through Google. A "Web application" OAuth client whose redirect URI is `PUBLIC_URL` + `/api/auth/google/callback`. Unset, the button is hidden. Separate from the spreadsheet import's `GOOGLE_CLIENT_*` below. |
| `SOCKET_REAUTH_MS` | How often a connected dashboard re-checks that its user is still active, signed in and in an active company (default 60000). A deactivated person stops receiving conversations within this long. |
| `RATE_LIMIT_SIGNUP_MAX`, `RATE_LIMIT_ACCOUNT_LINK_MAX`, `RATE_LIMIT_VERIFY_RESEND_MAX` | Sign-ups per hour per address (5), emailed links redeemed per hour per address (30), confirmation emails one person may have resent per hour (5). |

A company that signed itself up can use everything at once except one thing:
it cannot add the websites its widget runs on until its admin has confirmed
their email address, because anybody can type any business's name and domain
into a sign-up form. A company a superadmin created was vouched for and is not
held back.

### Email: two separate settings

- **`SMTP_*`** is the platform's own mail server: alerts, password resets,
  sign-up confirmations, invitations and usage warnings. Set `SMTP_HOST`,
  `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`. Without it, outside
  production, the link a confirmation or invitation would carry is written to
  the log so a developer can still finish signing up; in production it is
  not, and an admin inviting someone is shown the link to pass on instead.
- **`EMAIL_*`** is the **email support channel**: the outbound side through
  which operators' replies reach customers who wrote in by email, and reach
  chat visitors who left an address and went away before anyone answered. It
  also carries the six-digit code a visitor verifies their address with in
  the chat and the appointment reminder sent a day before a booking; without
  `EMAIL_HOST` and `EMAIL_FROM` the code is refused as unavailable and
  reminders are skipped.
  Inbound mail arrives via the per-tenant webhook shown under **Channels →
  Email**, authenticated by the secret in an `X-Inbound-Secret` header (a
  `?secret=` on the URL is still accepted). They are separate because
  customer-facing mail and alert mail usually go through different providers
  with different reputations.

**Who channel mail is from.** Replies go out `From:` `EMAIL_FROM` with the
display name "<the tenant's reply-as name> (via `PRODUCT_NAME`)", and
`Reply-To:` the tenant's support address, so they pass SPF and DMARC for the
platform's own domain; sending as the tenant's address through our server is
what a forged email looks like, and it used to land in spam. With no support
address set, the email says that replies are not read and to chat again. Set
`EMAIL_ALLOW_TENANT_FROM=true` only when your mail provider has verified your
tenants' domains; replies then go out from the tenant's own address. The
Email screen shows the inbound URL, when the last email arrived, the sender
customers will see, and a **Send a test** button
(`POST /api/companies/me/email/test`).

### Google spreadsheet import (optional, hidden by default)

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`
(`https://your-host/api/google/oauth2callback`) let a user connect their
Google account from the dashboard; see
[docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md). Without them the
Google routes answer 503 and everything else works.

Spreadsheet rows imported this way are stored as knowledge *documents* that
**the assistant does not yet read**. Because a card that imports rows the bot
then ignores only confused people, the Google Sheets card on **Bot →
Knowledge** is hidden unless `GOOGLE_SHEETS_UI=true`. The routes and code are
kept while what to do with them is decided. Material the bot should answer
from goes in through **Bot → Knowledge** (a whole website, an uploaded file, a
single page or PDF, or pasted text), which is chunked, embedded and searched
on every reply. A spreadsheet saved as CSV and uploaded there is answered from
today.

### Everything else

Rate limits, retention windows, backups, alert thresholds, vector-store
backends (`QDRANT_URL` / `MONGODB_VECTOR_INDEX`), upload and import size caps,
Stripe prices and the trial length are all in `.env.example` with their
defaults. `AI_COST_PER_REPLY` (default 0.002 dollars) is what one AI reply is
assumed to cost the platform, for the estimate on **Platform → Usage by
tenant**; it is for spotting a tenant who costs more than they pay, not for
accounting. Nothing needs to be set for a single-instance development run
beyond `MONGODB_URI`.

### Taking payment

Card details never reach this server. The customer pays on Stripe's own page,
a Checkout Session or a Payment Link, and Stripe posts the result to
`POST /api/billing/webhook/stripe`, which moves the tenant onto the plan they
bought.

1. Set `STRIPE_WEBHOOK_SECRET` to the signing secret of that endpoint. Without
   it every delivery is refused: the signature is the only authentication a
   public endpoint has.
2. Map each Stripe price to a plan with `STRIPE_PRICE_BASIC`,
   `STRIPE_PRICE_PROFESSIONAL` and `STRIPE_PRICE_ENTERPRISE`. A price with no
   mapping leaves the tenant's plan alone rather than guessing.
3. Tell Stripe which tenant is paying: `metadata.companyId` on the Checkout
   Session, or `client_reference_id` (the field a Payment Link can carry) if
   `STRIPE_ALLOW_CLIENT_REFERENCE=true`. Renewals and cancellations afterwards
   are matched by the Stripe customer and need no metadata.

A failed payment sets the subscription to `past_due`, which still entitles the
tenant; suspension stays a decision somebody makes.

**In-product checkout.** Set `STRIPE_SECRET_KEY` (a secret or restricted key
that can create Checkout Sessions and Billing Portal sessions) and `PUBLIC_URL`,
and a company admin can buy any plan that has a `STRIPE_PRICE_*` mapping:

- `POST /api/billing/checkout {plan}` creates a subscription Checkout Session
  carrying `metadata.companyId`, `metadata.planId` (also on the subscription)
  and `client_reference_id`, reuses the tenant's Stripe customer when there is
  one, and returns `{url}`. Stripe sends the customer back to
  `/admin/#billing?checkout=success` or `?checkout=cancelled`. Nothing changes
  until the webhook reports the payment. 503 `{configured:false}` without the
  key or the price; 409 when the tenant already has an active subscription.
- `POST /api/billing/portal` returns `{url}` of the Stripe Billing Portal for a
  tenant Stripe already knows (409 otherwise). Turn the portal on in Stripe's
  dashboard (Settings, Billing, Customer portal) and choose which plans
  customers may switch between there.
- `GET /api/billing/me` says what to offer: `checkout {available, plans}` and
  `portalAvailable`.

Starting a checkout is written to the audit log as `billing.checkout_started`.
No Stripe library is used; the calls go through axios. With the key set,
**Account → Plan & billing** also lists the tenant's invoices from Stripe
(`GET /api/billing/invoices`). Checkout and the portal are refused to an
agency admin working in a client's dashboard.

**The Agency plan and paying per resolution.** Two more ways to pay, set up
in [docs/INTEGRATIONS_SETUP.md §1.4](docs/INTEGRATIONS_SETUP.md#14-stripe-plans-the-agency-plan-and-per-resolution-pricing):

| Key | Default | What it is |
| --- | --- | --- |
| `PLAN_AGENCY_PRICE` | 299 | The Agency plan, per month. Offered only to companies a superadmin has made agencies. |
| `PLAN_AGENCY_CLIENTS_INCLUDED` | 10 | Client companies included in it. |
| `PLAN_AGENCY_CLIENT_PRICE` | 19 | Each client beyond those. Counted and shown; **not yet billed** through Stripe. |
| `PLAN_AGENCY_CLIENT_LIMIT` | 50 | Most clients one agency may hold unless a superadmin sets its own limit. |
| `PLAN_AGENCY_CLIENT_PLAN` | professional | The plan a client goes on when the agency pays for it. |
| `PRICE_PER_RESOLUTION_BASE` | 49 | Professional paid per resolution: the monthly base fee. |
| `PRICE_PER_RESOLUTION` | 0.49 | Price of one conversation the bot resolved. |
| `PRICE_INCLUDED_RESOLUTIONS` | 0 | Resolutions free each month. |
| `STRIPE_PRICE_AGENCY` | | Stripe price for the Agency plan. |
| `STRIPE_PRICE_RESOLUTION` | | The metered (usage-based) price on the resolutions Billing Meter. |
| `STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION` | | The base-fee price, needed when the base fee is not 0. |
| `STRIPE_RESOLUTION_EVENT` | resolutions | The Billing Meter's event name. |

Every figure above is a placeholder until the owner decides it, and Stripe
charges what its own price says, so the two must agree. A resolution is a
conversation the bot resolved by the value report's published definition,
counted once it has ended or sat idle a day; counted nightly at 01:15 and
reported to Stripe as the day's difference at 01:30 (`PUT
/api/billing/me/spend-cap` sets the tenant's monthly cap; past it resolutions
are not billed and the bot keeps answering, with warnings at 80% and 100%).
Without `STRIPE_SECRET_KEY` and `STRIPE_PRICE_RESOLUTION` resolutions are
counted and shown and nothing is sent to Stripe.

---

## 4. First run: creating the superadmin

The superadmin is **you, the platform operator**, not a customer. Customers
sign themselves up at `/admin/signup.html` (or are invited by you; see
section 10).

There is no default account and no seed script. While the database has **no
users at all**, one endpoint creates the first superadmin; it answers 403 the
moment any user exists. Passwords must be at least 12 characters.

```sh
curl -X POST http://localhost:3000/api/auth/create-superadmin \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "admin",
    "email": "you@example.com",
    "password": "a-long-passphrase-of-your-own",
    "displayName": "Platform admin"
  }'
```

Then sign in at `/admin/login.html`. The creation is written to the audit log.

---

## 5. Running the application

```sh
npm start
```

### Health checks

- `GET /health`: liveness; 200 whenever the process is up.
- `GET /ready`: readiness; 503 while MongoDB is unreachable.

Point a load balancer at `/ready` and a process supervisor at `/health`.

### Tests and lint

```sh
npm test        # in-memory MongoDB starts automatically; no local mongod needed
npm run lint
```

CI (`.github/workflows/ci.yml`) runs lint, the test suite, `npm audit
--audit-level=high` and a Docker image build on every push and pull request.

---

## 6. Deploying

### Docker

```sh
docker build -t chatbot-platform .        # or: npm run docker:build
docker run -d --name chatbot \
  --env-file .env \
  -e NODE_ENV=production \
  -p 3000:3000 \
  -v chatbot_uploads:/app/uploads \
  -v chatbot_backups:/app/backups \
  chatbot-platform
```

The image is `node:20-alpine`, runs as the unprivileged `node` user, contains no
`.env`, and has a `HEALTHCHECK` on `/health`. Whole-database backups
(`BACKUPS_ENABLED=true`) need `mongodump`, which is not installed by default;
there is a commented `apk add mongodb-tools` line in the Dockerfile for
deployments that want it. Per-tenant backups do not need it.

### Docker Compose

`docker-compose.yml` runs the app together with MongoDB 7:

```sh
cp .env.example .env    # fill in the secrets
docker compose up -d --build
```

Compose overrides `MONGODB_URI` to point at the `mongodb` container and mounts
volumes for `uploads/` and `backups/`. `docker compose --profile redis up -d`
adds a Redis container for multi-instance setups. Details in
[docs/DOCKER.md](docs/DOCKER.md).

### What a production deployment needs

- `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET`,
  `OPENAI_API_KEY` (the server will not start without them), plus `PUBLIC_URL`
  and `TRUST_PROXY` behind a proxy.
- `SMTP_*` for confirmations, invitations and password resets. Nothing
  refuses to start without it, but a self-signed-up customer then cannot
  confirm their address, and so cannot add their website. Set
  `SIGNUP_ENABLED=false` if customers should come only by invitation.
- **Persistent disk for `uploads/` and `backups/`.** Chat attachments (and
  images and documents customers send on WhatsApp, Messenger and Instagram)
  and backups are written to the local filesystem. Mount a volume over both
  or a redeploy throws them away; with several instances the volume has to be
  shared.
- Logs go to `logs/` and stdout; ship stdout.
- **`SECRETS_KEY`, set before the first tenant connects anything.** Every
  integration credential is encrypted with it.
- **`EMAIL_HOST` and `EMAIL_FROM`** if tenants will use in-chat email codes
  or booking reminders, besides email replies.

For the integrations, each optional (step by step in
[docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md)):

- **Push notifications:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` from `node scripts/generate-vapid-keys.js`, and the
  `web-push` dependency installed (`npm install` does it; the server logs and
  carries on without push when it is missing).
- **WhatsApp, Messenger, Instagram:** `PUBLIC_URL` on HTTPS with a certificate
  Meta accepts. Tenants bring their own Meta apps; Meta's App Review and
  business verification are theirs to pass.
- **Google Calendar booking:** a Google Cloud OAuth client (web application)
  with the Calendar API enabled, the redirect
  `PUBLIC_URL/api/booking/google/callback` registered, and
  `GOOGLE_CALENDAR_CLIENT_ID`/`_SECRET`. Its scopes are sensitive, so Google
  must verify the app before customers outside its test users can connect.
- **Agency plan and per-resolution billing:** the Stripe prices and the
  Billing Meter in the table under "Taking payment", and the price
  placeholders set to what you will actually charge.

### One instance or several

A single instance needs nothing beyond the above. For more than one:

1. Set `REDIS_URL` on every instance so socket.io rooms span instances.
2. Set `SCHEDULER_ENABLED=true` on exactly one instance and `false` on the
   others, or every instance runs the nightly backups and sends every alert.
3. Share the `uploads/` volume, or serve uploads from a shared store.

Rate-limit counters already live in MongoDB, so they are correct across
instances without further setup.

---

## 7. Security notes

- **Terminate TLS in front of the app** and set `TRUST_PROXY` to the number of
  proxies. Secure cookies, the widget's origin checks and rate limiting all
  depend on seeing the real scheme and client address.
- **`/metrics` is gated by `METRICS_TOKEN`** in production; scrape it with a
  bearer token rather than exposing it to the internet.
- **No default admin.** The first superadmin is created once through the
  endpoint above; nothing ships with a known password. Nobody else's password
  is chosen for them either: company admins and operators are invited and set
  their own (an admin can still create an account with a password they pick).
- **Signing out ends one device.** Each token carries an id; "Sign out"
  revokes that id until the token would have expired anyway, and every other
  device carries on. "Sign out on every device" (profile menu) and a password
  change end all of a person's sessions. Deactivating a person, or a whole
  company, refuses them at sign-in, on the next request and on the open
  socket (within `SOCKET_REAUTH_MS`), and returns their chats to the queue.
- **Rotate secrets deliberately.** Rotating `JWT_SECRET` signs everyone out;
  rotating `SESSION_SECRET` does the same and, unless `SECRETS_KEY` is set,
  makes tenants' stored action-node credentials unreadable. Set `SECRETS_KEY`
  before there is anything to lose.
- **The widget does not claim end-to-end encryption.** Messages travel over
  TLS to the server, which must read them to answer or route them. The earlier
  in-browser key exchange has been removed because it implied a guarantee the
  design cannot give.
- Tenant-typed URLs (workflow actions, webhooks, knowledge imports, the
  connector, MCP servers) and calls to Cal.com, Calendly and Google are
  fetched through an address-checked transport that refuses private,
  loopback and cloud-metadata ranges, including on redirects.
- **Meta's webhooks authenticate by signature alone.** Each delivery is
  checked against the tenant's app secret (`X-Hub-Signature-256`) over the
  raw bytes, which is why `/api/channels/webhook` is read raw before the JSON
  parser. A WhatsApp number, Page or Instagram account can be connected to
  one company only.
- **MCP tool descriptions come from the server.** The assistant reads them to
  decide what to call, so a tenant should connect only servers they trust.
  Tools start switched off, those that may change data ask the visitor first,
  and every call is audited without its values.
- **An agency working in a client's dashboard is on the client's record.**
  The one-hour token it gets is scoped to that client, every request it makes
  is written to the client's audit log (`agency.acted_as`), and billing is
  refused.
- **Push notifications say little.** They pass through the browser maker's
  push service and land on lock screens, so they carry who is waiting and,
  only where a person turned previews on, a short preview.

---

## 8. Features and endpoints

- **Frontend widget**: embeddable via `public/widget/js/widget-loader.js`.
  Under **Channels → Website widget**: a minimal snippet (script, key and
  server URL only, so later appearance changes reach installed sites without
  editing them), install instructions for HTML, WordPress, Shopify and Google
  Tag Manager, a desktop/phone live preview, the language, suggested
  questions, consent and a proactive message. The install check says
  "Seen on www.example.com, 4 minutes ago" once the widget has loaded on one
  of the tenant's allowed domains, and **Check my site**
  (`POST /api/companies/me/widget/check`) fetches a page and looks for the
  snippet. The widget greets in eleven languages, says it is an AI, shows the
  business name, offers thumbs on answers, and offers a person or a
  leave-a-message form whenever the bot cannot help. Pages can drive it with
  `window.ChatWidget` (`open`, `close`, `toggle`, `identify`, `verifyEmail`,
  `shutdown`, `on`/`off` for `open`, `close`, `message`, `handoff`,
  `verified`, `identity-expired`); see
  [public/widget/documentation.md](public/widget/documentation.md). Opening a
  page creates nothing: a conversation, a contact, a usage count and the
  `conversation.started` webhook happen only when the visitor first does
  something.
- **WordPress plugin and Shopify snippet**: **Channels → Website widget**
  offers both as downloads filled in with the tenant's key and this server's
  address (`/api/downloads/wordpress/support-desk-chat.zip`,
  `/api/downloads/shopify/support-desk-chat.liquid`; sources in
  `sdk/wordpress-plugin/` and `sdk/shopify/`). The WordPress plugin has a
  settings page, hides the chat on chosen paths, and signs a one-hour token
  for logged-in users on the server, refreshing it without a reload. The
  Shopify snippet is anonymous by default and recognises logged-in customers
  through an App Proxy token or a customer metafield hash. Neither is listed
  in its store yet.
- **WhatsApp, Messenger and Instagram**: **Channels → WhatsApp** and
  **Channels → Messenger & Instagram** connect a tenant's own Meta app.
  Messages arrive in the same inbox, are answered by the same bot and handed
  over the same way; the bot's choices become WhatsApp buttons or lists and
  Messenger quick replies; customers' images and documents are kept like
  uploads. Operators reply from the same composer, which shows the provider's
  24-hour reply window: past it WhatsApp allows only an approved template,
  and Messenger and Instagram a person's reply for up to seven days if Meta
  approved the Human Agent tag. Webhooks are verified by Meta's signature
  and a repeated delivery is ignored. Plan feature `channels` (trial,
  Professional, Agency, Enterprise; not Basic).
- **Booking**: **Bot → Booking** connects Cal.com (API key), Google Calendar
  (OAuth; services, opening hours, buffers and notice set in the dashboard,
  free times from free/busy in the business timezone) or Calendly (personal
  access token; books directly on paid Calendly plans, otherwise sends a
  pre-filled **Finish booking** link). The assistant and the "Book or change
  an appointment" template then offer real free times and book the one a
  customer picks, after they confirm; the time is checked again before
  booking, a double tap books once, and one conversation holds at most three
  upcoming appointments. Customers can cancel by reference; operators list,
  cancel and move bookings; a reminder goes by email about a day ahead;
  `booking.created` and `booking.cancelled` webhooks fire.
- **Who the visitor is**: a tenant's server signs a short-lived JWT (HS256,
  `sub`, `exp` within 24 hours, optional `aud` = widget key and signed
  `attrs`) passed as `data-user-jwt` or `ChatWidget.identify({jwt})`; the
  widget fires `identity-expired` so the page can hand it a fresh one. The
  older HMAC hash still works. A visitor with no login can verify their email
  address with a six-digit code in the chat (ten minutes, three tries, rate
  limited); that unlocks only actions marked "Email verification is enough".
  The assistant offers the code itself when verifying would unlock
  something. **People** shows how each person was verified and which
  attributes were signed.
- **Connected tools (MCP)**: **Bot → Actions → Connected tools (MCP)**. A
  tenant registers a remote MCP server (bearer token or custom header, stored
  encrypted; OAuth servers not yet), lists its tools and switches them on one
  by one: automatic or workflow only, verified customers only, ask before
  running. The assistant uses them with the same guards as saved Actions, and
  each one switched on counts toward the plan's actions allowance. Workflows
  cannot call MCP tools yet.
- **The operator app and push**: the dashboard installs as an app on
  Android, iPhone and iPad (iOS 16.4+, from Safari's Add to Home Screen) and
  desktop Chrome or Edge (`/admin/manifest.webmanifest`, a service worker that
  caches only the dashboard bundle and an offline page, never `/api`). With
  VAPID keys, **My settings → Notifications on this device** turns on push
  for new chats and hand-overs (to operators taking chats, inside business
  hours), assignments, transfers, long waits, low ratings, tasks and usage
  warnings; previews are off unless a person turns them on per device.
- **Agencies and white-label**: a superadmin makes a company an agency
  (**Platform → Companies → Make agency**). Its admins get **Clients**: a list
  with each client's plan, status, install, conversations, resolution rate
  and last activity; **Add client** (a company and an invitation to its admin
  under the agency's brand); **Open client dashboard** (a one-hour token
  scoped to that client, every request audited, billing refused); and
  **Remove client** (detaches, deletes nothing). On a plan with
  `customBranding` (Agency, Enterprise) the agency's name, logo, colour and
  support address replace the product's on its clients' dashboards, sign-in
  and invitation pages and platform emails.
- **Per-resolution pricing with a cap**: Professional can be paid as a base
  fee plus a price per conversation the bot resolved (the value report's
  definition, counted once a conversation ended or sat idle a day), reported
  daily to a Stripe Billing Meter. The tenant sets a monthly spending cap;
  past it nothing more is billed and the bot keeps answering. See "Taking
  payment" above.
- **Nobody waits unnoticed, nothing stays open for ever**: **Team →
  Routing → Alert the team when someone has waited this long for a person**
  (default 5 minutes, 0 off) sends a `visitor_waiting` notification, by bell
  and push, to admins and to operators taking chats, once per wait. Web chats
  idle for `IDLE_CLOSE_HOURS` (24) that nobody holds are ended, so
  `conversation.ended` now fires for conversations the bot handled alone.
  A hand-over carries a summary ("Asked: …", the visitor's last three
  messages).
- **Admin dashboard**: `/admin`. Grouped by job: Inbox (live chats, history,
  people, tasks), Bot (knowledge, persona and canned replies, actions and
  connected tools, booking, workflows, test your bot, unanswered questions),
  Channels (widget, email, WhatsApp, Messenger & Instagram, business hours),
  Team, Reports, Account (plan and billing, retention, audit log), Developers
  (your systems, identity verification, webhooks, API keys; shown only on
  plans with API access), and Clients for an agency. A new company admin
  lands on **Home**: a setup checklist that ticks from what has actually
  happened (knowledge added, persona written, bot tried, website added,
  widget seen on a page), then the value report, unanswered questions, usage
  and who is online. A superadmin sees a Platform area (companies, usage by
  tenant, platform audit) instead of tenant settings.
- **API**: see `routes/`: auth, admin, chat, widget, upload, companies,
  contacts, tasks, notifications, workflows, workflow-execution, knowledge,
  bot, actions, mcp, booking, channels, push, agency, downloads, templates,
  billing, webhooks, email, google, gdpr, api-keys and operations. The full
  list is in [docs/FUNCTIONALITY_MAP.md](docs/FUNCTIONALITY_MAP.md).
- **Knowledge base**: **Bot → Knowledge**. Read a whole site in the
  background with progress (sitemap or links, same domain, capped by
  `KNOWLEDGE_CRAWL_MAX_PAGES`), upload a PDF, text, Markdown, CSV or HTML
  file, import one page or PDF by URL, or paste text (and edit it later); it
  is chunked, embedded and searched by the assistant on every question and by
  any workflow knowledge node. A site or a page can be read again every week;
  a re-crawl drops pages the site no longer has. Each source says how many
  answers used it. Answers cite the sources they drew on.
- **Test your bot**: **Bot → Test your bot** runs the real reply path without
  saving a conversation or counting usage, and explains each answer: which
  passages matched and how well, which tools were called, and, when nothing
  matched or the model could not answer, exactly what a visitor would get
  instead. Any exchange can be saved as a **test** (the answer must mention
  something, hand over, or cite a source); up to 50 per company, run on demand
  and again after every lesson taught.
- **Unanswered questions and Teach the bot**: **Bot → Unanswered questions**
  groups what the bot could not answer, answers visitors marked unhelpful, and
  conversations handed over after an answer. **Add the answer** opens **Teach
  the bot**, which saves it as knowledge or as a canned reply, marks the
  conversation fixed and re-runs the saved tests. The same dialog is on bot
  messages in a transcript, and an admin can save an operator's reply as the
  bot's answer.
- **Workflows**: **Bot → Workflows**. Several can be live at once, each with a
  trigger: when the visitor wants something (an intent described in a
  sentence), when a message mentions certain words, or for every message (at
  most one). A message no workflow takes goes to the assistant, and a
  workflow that has finished does not hold the conversation. Editing a live
  workflow makes a draft; visitors keep the live version until it is
  published again ("Live: v3 · Draft: v4"). Unpublish, duplicate and rename
  from the list.
- **Actions**: **Bot → Actions**. Calls into the tenant's own systems that
  the assistant may choose to make itself, or that only workflows use, with a
  **Run once** tester and the last 20 runs; see IMPLEMENTATION_STATUS.md for
  the safeguards.
- **Reports**: volume, response times, satisfaction and, on every plan, a
  **value report**: conversations resolved by the bot (by a published, strict
  definition), handed to a person, hours saved at the tenant's own minutes per
  conversation, cost per resolution, AI replies, and satisfaction for the bot
  against people; exportable as CSV.
- **Monitoring**: Prometheus metrics at `/metrics`.
- **Public read API**: `/api/v1`, authenticated by an API key a company admin
  creates under **Developers → API keys**. See below.

### What is reachable without signing in

- Pages: `/admin/login.html`, `/admin/signup.html`, `/admin/invite.html`.
- `/api/auth`: `GET /config` (product name, whether sign-up and Google
  sign-in are on, and an agency's brand for `?invite=` or `?company=`),
  `POST /login`, `POST /signup`, `GET /verify-email`,
  `GET /invite/:token`, `POST /accept-invite`, `POST /forgot-password`,
  `GET /reset-info`, `POST /reset-password`, `GET /google/start`,
  `GET /google/callback`, and `POST /create-superadmin` while no user exists.
  The sign-up, emailed-link and login routes are rate limited per address.
- The widget's own: `GET /api/widget/config`, the socket, and `/api/chat/*`
  and `/api/upload` with the visitor's session token.
- Signed or secret-carrying inbound hooks: `POST /api/billing/webhook/stripe`,
  `POST /api/email/inbound/:companyId/:provider?`, and Meta's
  `GET`/`POST /api/channels/webhook/whatsapp|messenger|instagram` (the GET
  answers only a verify token this server issued; the POST only a valid
  signature).
- `GET /api/booking/google/callback`, Google's redirect after a tenant
  connects a calendar; it trusts only a signed state bound by a cookie to the
  browser that started the flow.
- `GET /api/downloads/wordpress/support-desk-chat.zip` and
  `/api/downloads/shopify/support-desk-chat.liquid`, filled in when `?key=`
  is a real widget key (which is public anyway).
- `GET /admin/manifest.webmanifest`, `GET /api/billing/plans`,
  `GET /api/gdpr/privacy-policy`, `GET /api/workflow-execution/health`,
  `/health`, `/ready`, and `/metrics` with its token.

---

## 9. The public read API

Outbound webhooks push events as they happen; this is for pulling: a backfill,
a warehouse load, or a report of your own. Read-only.

```sh
curl -H "Authorization: Bearer ck_..." \
  "https://your-host/api/v1/conversations?limit=100&since=2026-01-01"
```

- `GET /api/v1/me`: what the key is and which scopes it has. Start here.
- `GET /api/v1/conversations`: `status`, `tag`, `since`, `until`, `limit`, `cursor`.
- `GET /api/v1/conversations/:sessionId`: one conversation with its transcript.
- `GET /api/v1/contacts`: `email`, `externalId`, `since`, `until`.
- `GET /api/v1/tasks`: `status`, `since`, `until`.

Paging is by cursor: pass back the `nextCursor` you were given. Keys are
scoped per resource (`conversations:read`, `contacts:read`, `tasks:read`),
rate limited per key against the tenant's plan, and shown once at creation;
only a hash is stored. Revoking is immediate. The API requires a plan that
includes `apiAccess`, checked per request.

---

## 10. Multi-tenant architecture

- **Superadmin**: the platform operator. Manages all companies, invites their
  first admins, sees all data.
- **Company admin**: manages the team (invites operators and other admins),
  the bot and the company's settings. Admins answer chats too but do not use
  a seat.
- **Operator**: handles chats within their company. Each operator, invited
  ones included, holds one of the plan's seats.
- **Agency admin**: a company admin whose company a superadmin has made an
  agency. Besides their own company they manage client companies: add them,
  open their dashboards for an hour at a time (on the client's audit record),
  and brand them. A client is an ordinary company with a link to its agency;
  removing it from the agency deletes nothing.

### Onboarding a company

**Self-serve (the usual way).** The customer opens `/admin/signup.html` and
gives their email, company name, a password and, optionally, their website.
That creates the company on the trial, its first admin and a signed-in
session, sends a confirmation email, and starts reading the website into the
knowledge base in the background, so the bot knows something by the time they
reach **Home**. From there the checklist walks them through: add knowledge,
write the persona (a guided builder, or "Draft from my website"), try the bot,
add their website under **Allowed domains** once the email is confirmed, and
paste the snippet. They invite colleagues under **Team**; each invitee gets an
email with a link (valid seven days) to `/admin/invite.html`, where they
choose their own password. If the email cannot be sent, the admin is shown
the link to pass on.

**By the superadmin.** Create the company under **Platform → Companies**,
giving the first admin's email address (required). They are sent the same
invitation; no password is generated or shown. Then they follow the same
checklist.

The snippet's `data-widget-key` attributes incoming chats to the company, and
the widget answers only on origins listed under that company's **Allowed
domains**. A domain another company has already registered is refused.

---

## 11. Additional notes

- Static files are served from `public/`.
- `logs/`, `uploads/` and `backups/` are written at runtime, are gitignored,
  and are excluded from the Docker image.

---

## 12. Troubleshooting

- The server exits at startup with a configuration error: read the message;
  it names the variable. See section 3.
- Check `logs/` (or the container's stdout) for errors.
- MongoDB must be reachable: `GET /ready` says whether it is. With Compose,
  `docker compose ps` and `docker compose logs mongodb`.
- Password-reset, confirmation or invitation mail not arriving: `SMTP_HOST`
  is unset (the log says so, and outside production prints the link) or
  `PUBLIC_URL` is wrong, so the link points at localhost. An admin whose
  invitation could not be emailed is shown the link to send by hand.
- "Confirm your email address before adding a website": the company signed
  itself up and its admin has not opened the confirmation link yet. The banner
  at the top of the dashboard resends it.
- An operator's reply to a chat visitor who has gone says it could not be
  emailed: `EMAIL_HOST` (and `EMAIL_FROM`) are unset. The reply is still in
  the transcript.
- No "Sign in with Google" button: `GOOGLE_SIGNIN_CLIENT_ID` or
  `GOOGLE_SIGNIN_CLIENT_SECRET` is unset. A Google account with no matching
  account here is refused; it does not create one.
- Google import unavailable (503): `GOOGLE_CLIENT_ID` is unset, or the
  redirect URI in Google Cloud does not match `GOOGLE_REDIRECT_URI` exactly.
  The card is hidden altogether unless `GOOGLE_SHEETS_UI=true`.
- "Push notifications are not set up on this server": one of `VAPID_*` is
  missing or malformed, or the `web-push` package is not installed (the log
  says which).
- Meta will not verify a webhook: `PUBLIC_URL` is not HTTPS, or the verify
  token pasted into Meta is not the one the tenant's Channels screen shows
  now (making a new one replaces it). Verified but no messages: the tenant's
  plan lacks `channels` (the screen says so), the `messages` field is not
  subscribed, or for WhatsApp the business account is not subscribed to the
  app.
- "Google Calendar is not set up on this server" (503 on connect): no
  `GOOGLE_CALENDAR_CLIENT_ID`/`_SECRET` and no `GOOGLE_CLIENT_*` to fall back
  to. A tenant sent back with an error after Google's screen: the redirect
  URI registered in Google Cloud does not match exactly.
- A visitor told "Email verification isn't available right now":
  `EMAIL_HOST` or `EMAIL_FROM` is unset.

## 13. Further reading

- [docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md) — step-by-step
  setup for the platform operator (VAPID keys, the Google Calendar OAuth
  client, Stripe prices and meters, agencies) and for tenants (Cal.com,
  Google Calendar, Calendly, WhatsApp, Messenger and Instagram, signed
  identity, email codes, WordPress, Shopify, MCP, the operator app).

- [docs/PRODUCT.md](docs/PRODUCT.md) — what the product is, everything it
  does, the market, how competitors connect customer data, and a ranked plan.
- [docs/FUNCTIONALITY_MAP.md](docs/FUNCTIONALITY_MAP.md) — every endpoint,
  socket event, model and setting, read from the code.
- [public/widget/documentation.md](public/widget/documentation.md) — the
  install guide for tenants: snippet, attributes, JavaScript API, CSP.
- [docs/research/](docs/research/) — market landscape and customer-data
  connection research with sources (September 2026).
