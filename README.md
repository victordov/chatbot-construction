# Chatbot Platform

Multi-tenant customer-support chat: an embeddable widget, an operator
dashboard, an AI assistant that answers from each tenant's own knowledge base,
and a visual workflow editor. Node.js, Express, MongoDB, socket.io.

What is built and what is not is in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
and [todo.md](todo.md).

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

`npm run dev` restarts on file changes. The server listens on `PORT`
(default 3000); the dashboard is at `/admin`.

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
| `PUBLIC_URL` | The address customers reach you at. Used in password-reset emails, the embed snippet and the email channel's inbound URL. |
| `TRUST_PROXY` | Number of reverse proxies in front of the app (usually `1`), so secure cookies and rate limiting see the real client address. Defaults to `1` in production. |
| `ALLOWED_DOMAINS` | Origins allowed to load the widget in addition to those each tenant registers. No wildcards. |
| `METRICS_TOKEN` | Bearer token a Prometheus scraper must send. In production `/metrics` is only exposed when this is set. |
| `SECRETS_KEY` | Encrypts the credentials tenants store for workflow action nodes. Without it the key is derived from `SESSION_SECRET`, so rotating that would make stored credentials unreadable. |

### Running more than one instance

| Key | What it is |
| --- | --- |
| `REDIS_URL` | Switches socket.io to the Redis adapter so an operator on one instance can reach a visitor on another. Required from the second instance on. |
| `SCHEDULER_ENABLED` | Background jobs (retention, alerting, backups, webhook retries, deadline reminders) run wherever this is `true` (the default). Set it to `true` on exactly one instance and `false` on the rest. Metrics collection and `/metrics` are unaffected. |
| `OPERATOR_GRACE_MS` | How long a conversation waits for its operator to reconnect before returning to the queue (default 60000). |
| `WORKFLOW_CACHE_TTL_MS` | How long an instance keeps a tenant's published workflow before checking for a newer one (default 30000). |

### Email: two separate settings

- **`SMTP_*`** is the platform's own mail server: alert emails and
  password-reset emails. Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` and
  `SMTP_FROM`.
- **`EMAIL_*`** is the **email support channel**: the outbound side through
  which operators' replies reach customers who wrote in by email. Inbound mail
  arrives via the per-tenant webhook shown under Settings → Email. They are
  separate because customer-facing mail and alert mail usually go through
  different providers with different reputations.

### Google spreadsheet import (optional)

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`
(`https://your-host/api/google/oauth2callback`) let a user connect their
Google account from the dashboard; see
[docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md). Without them the
Google routes answer 503 and everything else works.

Spreadsheet rows imported this way are stored as knowledge *documents* that
**the assistant does not yet read**. The flow is kept while that is decided.
Material the bot should answer from goes in through **Settings → Knowledge
Base** (web page, PDF or pasted text), which is chunked, embedded and searched
on every reply.

### Everything else

Rate limits, retention windows, backups, alert thresholds, vector-store
backends (`QDRANT_URL` / `MONGODB_VECTOR_INDEX`), upload and import size caps,
Stripe prices and the trial length are all in `.env.example` with their
defaults. Nothing needs to be set for a single-instance development run beyond
`MONGODB_URI`.

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
No Stripe library is used; the two calls go through axios.

---

## 4. First run: creating the superadmin

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
- **Persistent disk for `uploads/` and `backups/`.** Chat attachments and
  backups are written to the local filesystem. Mount a volume over both or a
  redeploy throws them away; with several instances the volume has to be
  shared.
- Logs go to `logs/` and stdout; ship stdout.

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
  endpoint above; nothing ships with a known password.
- **Rotate secrets deliberately.** Rotating `JWT_SECRET` signs everyone out;
  rotating `SESSION_SECRET` does the same and, unless `SECRETS_KEY` is set,
  makes tenants' stored action-node credentials unreadable. Set `SECRETS_KEY`
  before there is anything to lose.
- **The widget does not claim end-to-end encryption.** Messages travel over
  TLS to the server, which must read them to answer or route them. The earlier
  in-browser key exchange has been removed because it implied a guarantee the
  design cannot give.
- Tenant-typed URLs (workflow actions, webhooks, knowledge imports, the
  connector) are fetched through an address-checked transport that refuses
  private, loopback and cloud-metadata ranges, including on redirects.

---

## 8. Features and endpoints

- **Frontend widget**: embeddable via `public/widget/js/widget-loader.js`; the
  snippet is under **Install Widget** in the dashboard.
- **Admin dashboard**: `/admin`.
- **API**: see `routes/`: auth, admin, chat, widget, upload, companies,
  contacts, tasks, notifications, workflows, workflow-execution, knowledge,
  templates, billing, webhooks, email, google, gdpr, api-keys and operations.
- **Knowledge base**: **Settings → Knowledge Base**. Import a web page or PDF,
  or paste text; it is chunked, embedded and searched by the assistant on every
  question and by any workflow knowledge node. The same screen has a "try a
  question" box.
- **Monitoring**: Prometheus metrics at `/metrics`.
- **Public read API**: `/api/v1`, authenticated by an API key a company admin
  creates under **Settings → API keys**. See below.

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

- **Superadmin**: manages all companies, creates company admins, sees all data.
- **Company admin**: manages operators within their company and its settings.
- **Operator**: handles chats assigned to them within their company.

### Onboarding a company

1. Sign in as a superadmin and create the company under **Companies**.
2. Create a company admin for it.
3. As that company admin, open **Install Widget**. Copy the embed snippet onto
   the customer's site and add their origin(s) under **Allowed domains**.

The snippet's `data-widget-key` attributes incoming chats to the company.
Without it, a conversation is only matched if the page's origin is registered
under **Allowed domains**.

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
- Password-reset mail not arriving: `SMTP_HOST` is unset (the log says so) or
  `PUBLIC_URL` is wrong, so the link points at localhost.
- Google import unavailable (503): `GOOGLE_CLIENT_ID` is unset, or the
  redirect URI in Google Cloud does not match `GOOGLE_REDIRECT_URI` exactly.

## 13. Further reading

- [docs/PRODUCT.md](docs/PRODUCT.md) — what the product is, everything it
  does, the market, how competitors connect customer data, and a ranked plan.
- [docs/FUNCTIONALITY_MAP.md](docs/FUNCTIONALITY_MAP.md) — every endpoint,
  socket event, model and setting, read from the code.
- [docs/research/](docs/research/) — market landscape and customer-data
  connection research with sources (September 2026).
