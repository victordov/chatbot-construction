# Implementation status

_Last reviewed: 2026-10-22 (after Phase 2)_

## 2026-10-22: Phase 2, the roadmap features

The launch-review pass below made the product something a business could
trust on its own website. Phase 2, merged into the same uncommitted working
tree the same day, built the things the review and docs/PRODUCT.md put in
"the next ninety days": reaching customers where they already are, knowing
who they are, acting in more of their systems, and pricing that follows
results. The suite is now 1,976 passing tests (2 skipped: the PHP checks need
`php`) in 114 suites, up from about 1,585 in 94; lint has no errors and the
build passes. Setup for every third party below is written out step by step
in [docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md).

**Real booking in the tenant's own diary.** Until now "book an appointment"
meant the tenant building and hosting a connector, or a workflow that took a
preferred time and raised a task for somebody to call back about. **Bot →
Booking** (`routes/booking.js`, `services/booking/`) connects Cal.com (an API
key; the v2 API with the `cal-api-version` each endpoint expects, pinned),
Google Calendar (OAuth with its own client, `GOOGLE_CALENDAR_CLIENT_ID/
SECRET/REDIRECT_URI`, falling back to the Sheets client; because Google holds
events rather than appointments, the tenant defines services, opening hours,
buffers and minimum notice here and free times are worked out from free/busy
in the business timezone), or Calendly (a personal access token; on a paid
Calendly plan the Scheduling API books directly, and on the free plan, which
cannot, the bot returns a single-use scheduling link pre-filled with the
visitor's details, `status: 'link'`, shown in the widget as **Finish
booking**). Behind one provider interface (list services, slots, book,
cancel, reschedule), a connected calendar answers the connector capabilities
`availability.slots`, `availability.book` and the new `availability.cancel`
(by reference, from the same conversation or with the email it was booked
under; also in the SDK as `cancelBooking`), so the assistant's tools, the
workflow "Use your data" node and the widget's slot buttons work unchanged.
The guards are the ones writes already had - the visitor confirms first, a
preview or Test your bot never books - plus several of its own, because a
slot id comes back through a visitor's tap or a model's arguments: the
service must be one the bot may book, the time is checked as still free, the
same tap twice is one booking, and one conversation holds at most three
upcoming appointments. Every booking is a `Booking` record with a reference,
an audit entry and a `booking.created` or `booking.cancelled` webhook;
operators list, cancel and move them (`/api/booking/bookings`); a reminder
goes by email about a day ahead (every 15 minutes the scheduler claims what
is due; it needs `EMAIL_HOST`/`EMAIL_FROM`); GDPR erasure removes the
person's bookings. The "Book or change an appointment" template now offers
real free times when a calendar is connected and falls back to the task path
when nothing is.

**WhatsApp, Messenger and Instagram in the same inbox.** Web and email were
the only ways in, and every product in the market's baseline has these.
**Channels → WhatsApp** and **Channels → Messenger & Instagram**
(`routes/channels.js`, `services/channels/`) connect a tenant's own Meta app:
one `ChannelAccount` per provider per company, a number, Page or Instagram
account connectable to one company only, the token and app secret encrypted.
Meta posts to `/api/channels/webhook/:provider`; the GET handshake answers
only a verify token this server issued, and every POST is checked against
`X-Hub-Signature-256` over the raw bytes, which is why that path is read raw
before the JSON parser. Graph API `v26.0` is pinned. Text, buttons, lists,
quick replies and postbacks come in; images and documents are kept like
uploads; each message is stored with the provider's own id so a repeated
delivery changes nothing; and the bot answers through exactly the widget's
path (the reply helpers moved from `websockets.js` into
`services/conversation-lifecycle.js` so both could use them), after the 200,
since Meta wants an answer within seconds and a model may take longer. The
bot's choices become WhatsApp reply buttons or lists and Messenger quick
replies. Operators answer from the same composer, which shows the provider's
rule: a free reply within 24 hours of the customer's last message; after
that, on WhatsApp, only an approved template the tenant configured (free text
is refused rather than lost), and on Messenger and Instagram a person's reply
for up to seven days with the HUMAN_AGENT tag, if the admin ticked that Meta
approved it. Read receipts go back, and a failed delivery leaves a line in
the transcript. The inbox shows an app badge, History filters by app, and
People's timeline marks app conversations. The plan feature `channels` is on
the trial, Professional, Agency and Enterprise, not Basic.

**An operator app with push.** The inbox worked on a phone one pane at a
time, but nothing reached a receptionist whose browser was closed. The
dashboard is now an installable app: a manifest served at
`/admin/manifest.webmanifest` under `PRODUCT_NAME`, icons drawn by
`scripts/generate-app-icons.js`, and a service worker (`public/admin/sw.js`)
that caches only the dashboard bundle and an offline page - never `/api`,
never the dashboard page itself, because a stale conversation list is worse
than none. Android and desktop Chrome or Edge install from a button or the
profile menu; iPhone and iPad (iOS 16.4+) from Safari's Add to Home Screen,
with the steps shown. Web Push uses VAPID keys (`VAPID_PUBLIC_KEY/
PRIVATE_KEY/SUBJECT`, made by `node scripts/generate-vapid-keys.js`; the
`web-push` dependency, ^3.6.7, sends): new chats and hand-overs go to
operators taking chats, according to each device's setting, and not outside
business hours; assigned, transferred, long wait, low rating, task assigned
and usage warning go through `notifyUser` to the person concerned. A
notification passes through the browser maker's service and lands on a lock
screen, so previews are off per device until its owner turns them on. A
device that is gone, or whose session was signed out, is pruned; the
dashboard's own desktop alert stands down in a browser where push is on, so
nobody is told twice; without keys nothing is sent and **My settings →
Notifications on this device** says why.

**Knowing who the visitor is, and letting an anonymous one prove it.** A
visitor could be verified only by the tenant's HMAC of a user id, the scheme
Intercom and Chatbase have deprecated: it never expires and carries nothing
but the id. `services/visitor-identity.js` now accepts a signed JWT (HS256
with the company's identity secret; `sub` required; `exp` required and at
most 24 hours out; `aud`, when present, must be the widget key; signed
`attrs` stored as the contact's signed attributes) through `data-user-jwt` or
`ChatWidget.identify({jwt})`, and the widget fires `identity-expired` so the
page can fetch a fresh token without the visitor noticing. HMAC still works.
**Developers → Identity verification** shows both, JWT first, with Node,
Python, PHP and Ruby examples carrying the tenant's own widget key. For a
visitor with no login, `services/visitor-verification.js` sends a six-digit
code to an address they type (ten minutes, three attempts; three codes per
session per ten minutes, five per address per hour, and
`VERIFY_EMAIL_HOURLY_LIMIT` per tenant per hour, all counted in MongoDB), in
the visitor's language, through the email channel's sender; typing it back
makes the contact verified `verifiedBy: 'email_code'`. A code proves an inbox
rather than a login, so it unlocks only actions marked **Email verification
is enough** (`Action.verification: 'email'`), enforced in
`services/actions.js#resolveInputs` as well as in what the assistant is
offered; when verifying would unlock something, the assistant gets a
`verify_visitor_email` tool, and calling it shows the visitor a button that
opens the code form. Pages can open it themselves (`ChatWidget.verifyEmail()`)
and hear `verified`. Contacts are kept apart deliberately: a typed email never
threads a session onto a verified contact, a code-verified session never
joins a signed one, and `contact.identified` also fires when a code-verified
person later signs in. People shows how each person was verified and which
attributes were signed.

**A WordPress plugin and a Shopify snippet.** Tidio and Gorgias reached their
customers through these two stores. `sdk/wordpress-plugin/support-desk-chat/`
is a complete plugin - settings page, pages to hide on, a one-hour JWT signed
on the server for logged-in users and refreshed through `admin-ajax`,
uninstall cleanup, `readme.txt` - and `sdk/shopify/support-desk-chat.liquid`
a theme snippet that is anonymous by default and recognises logged-in
customers through an App Proxy that returns a token, or a customer metafield
holding a hash, with a README. **Channels → Website widget** offers both as
downloads filled in with the tenant's key and this server's address
(`routes/downloads.js`). Neither is listed in its store.

**MCP: any system that publishes tools.** The connector SDK meant a tenant
writing and hosting code; Shopify, Stripe, HubSpot, Zapier and Notion already
publish MCP servers. **Bot → Actions → Connected tools (MCP)**
(`services/mcp-client.js`, `routes/mcp.js`, `models/mcp-server.js`)
registers a remote server (https only, http on localhost in development;
no auth, a bearer token or a custom header, encrypted; OAuth servers not
yet), and the client speaks both eras in use: the stateless 2026-07-28
revision (`server/discover`, `_meta`, the `Mcp-*` headers) and the legacy
`initialize` handshake with a session id, JSON or server-sent-event replies,
paging, a 15-second deadline, a 1 MB cap and every request through
`safe-http`. Tools arrive switched off; each has its own switches - on,
automatic or workflow only, verified customers only, ask before running (on
unless the server marks it read-only, and back on if it stops claiming to
be) - and each switched on counts toward the plan's actions allowance, which
now counts saved Actions and enabled tools together. The assistant is offered
enabled automatic tools with their schemas cut down to what a model accepts,
under the Actions guards: the verified gate (a signed visitor only), the
confirmation rule, one write per turn, a test never calling a tool that is
not read-only, results fenced and capped at 4 KB, and an `mcp.tool_called`
audit entry without values or secrets. `mcp_` names are reserved. Workflows
cannot call MCP tools yet. The screen tells tenants plainly that tool
descriptions come from the server, so only servers they trust belong there,
and that "verified only" limits who can trigger a tool, not whose data it
reads.

**Agencies and white-label.** An agency running ten clients' desks had to keep
ten logins, and `customBranding` was a plan flag nothing read. A superadmin
now marks a company as an agency (**Platform → Companies → Make agency**, with
a client limit). Its admins get **Clients** (`routes/agency.js`,
`services/agency.js`): each client's plan, status, whether the widget is
installed, conversations, resolution rate and last activity; **Add client**,
which creates the company and invites its admin under the agency's brand, on
a trial or on the client plan the agency pays for; **Open client dashboard**,
a one-hour token scoped to that client, with a banner, sockets that follow the
client, billing refused, and every request - reads included - written to the
client's audit log as `agency.acted_as`; and **Remove client**, which detaches
and deletes nothing. On a plan with `customBranding` (the new Agency plan, or
Enterprise) the agency's product name, https logo, colour and support address
replace the product's on its clients' dashboards, their sign-in and
invitation pages, and the platform's emails to them. Professional no longer
lists custom branding, which was never built there.

**Pricing that follows results, with a cap.** The value report already
counted conversations the bot resolved, by a published definition; nothing
charged by it. `services/resolutions.js` uses exactly that definition -
imported, so a bill can be checked against the tenant's own Reports screen -
and counts a conversation only once it has ended or sat idle for a day, so a
resolution that later becomes a hand-over is never billed. Professional can
be paid as a base fee plus a price per resolution, with optional included
resolutions; the counts run nightly at 01:15 and the day's difference goes to
a Stripe Billing Meter at 01:30, identified `res_<company>_<YYYY-MM>_<day>` so
a retry counts once. The tenant sets a monthly spending cap (`PUT
/api/billing/me/spend-cap`): past it resolutions are not billed and the bot
keeps answering, with the usual warnings at 80% and 100%. The new Agency plan
is shown only to agencies. Every price is read from the environment
(`PLAN_AGENCY_*`, `PRICE_PER_RESOLUTION*`) because none has been decided.
Clients beyond an agency's included ones are counted and shown, not yet
billed.

**Smaller changes made while merging.**
- **Nobody waits unnoticed.** **Team → Routing** has "Alert the team when
  someone has waited this long for a person" (default 5 minutes, 0 off): a
  `visitor_waiting` notification, by bell and push, to admins and to
  operators taking chats, once per wait (`handoff.escalatedAt`, claimed
  atomically). The notification type existed and nothing created it.
- **Idle chats end.** Web chats silent for `IDLE_CLOSE_HOURS` (24) and not
  held by an operator are ended, so they leave the queue and
  `conversation.ended` fires with `endedBy: 'idle'` - before this a
  conversation the bot handled alone never ended. Email and app threads are
  left alone, because their next message may come days later.
- **A hand-over says what was asked.** `handoff.summary`, in the schema and
  never written, is now "Asked: …" with the visitor's last three messages.
- **Forcing is explicit.** Ending or leaving a colleague's chat needs
  `force: true`, which the dashboard sends only after its confirmation, and
  the server enforces it.
- **Deleting a company deletes its data.** Every company-scoped collection
  goes - conversations, contacts, files, workflows, actions, webhooks,
  channel, calendar and MCP credentials, bookings, push devices, saved tests
  - found from the schemas so a new model is not left behind. Users must
  still be removed first, and the audit log is kept.
- **The checklist's persona step** follows the persona the assistant actually
  uses, not a Persona node in any published workflow.
- **Task assignment** is scoped to the company in the service as well as in
  the route.
- **A fast-clicking new admin is not rate limited.** Signed-in dashboard users
  get at least `RATE_LIMIT_DASHBOARD_MIN` (300) requests a minute; a Home load
  is a dozen requests and the trial's 60 a minute was reachable. API keys
  still get the plan's number.
- Workflow run statistics wait for a flush already in flight (a race); the
  WhatsApp screen's placeholders read "e.g. …" rather than looking like real
  values; `.env.example` now lists every new key, plus `IDLE_CLOSE_HOURS`,
  `WORKFLOW_PICK_*` and `WORKFLOW_STATS_FLUSH_MS`.

### Phase 2: what was checked in a browser, and what was not

Walked in a browser against a local server, with no console errors: **Bot →
Booking**, **Channels → WhatsApp**, **Channels → Messenger & Instagram**,
**Bot → Actions → Connected tools (MCP)**, **Developers → Identity
verification**, **My settings → Notifications on this device**, and **Plan &
billing**.

Not exercised live, because each needs an account or a device outside this
machine: a real Meta app (WhatsApp, Messenger or Instagram messages in either
direction, App Review, templates), Cal.com, Google Calendar, Calendly, a
Stripe Billing Meter and per-resolution invoice, a real MCP server, push
delivered to a phone, and installing the WordPress plugin or the Shopify
snippet on a real site. The automated suite covers each against stubbed
APIs; it does not tell us they work against the real services, and the first
real setup of each should be treated as its test.

## 2026-10-22: the launch-review pass

A review in October asked one question of every screen and every path: could
a business we have never spoken to sign up, get a bot answering on their site,
and trust it with their customers? It found twelve things that would stop a
launch, seventeen that would hurt one, and a list of quick wins. This pass
fixed them. The suite is now about 1,585 tests in 94 suites (from about 1,070
in 60), lint is clean and the build passes. What follows is what now works end
to end; the older sections below have been corrected where this changed them.

**A customer can get from nothing to a working bot on their own.** Until now
the only way in was a superadmin creating the company and handing somebody a
generated password over chat. `/admin/signup.html` (`POST /api/auth/signup`,
off with `SIGNUP_ENABLED=false`) creates the company on the trial, its first
admin and a signed-in session in one step, emails a confirmation link, and, if
a website was given, starts reading it into the knowledge base in the
background so the bot knows something by the time they reach Home. Everything
works before the address is confirmed except adding the websites the widget
may run on, because anybody can type somebody else's business into a sign-up
form. Home is a checklist that ticks from what has happened rather than from
what exists: knowledge added, persona written, the bot tried in Test your bot
(`onboarding.botTestedAt`), a website added, and the widget seen loading on
one of those sites (`widgetSeen`, "Seen on www.example.com, 4 minutes ago") -
a conversation existing no longer counts as installed. Colleagues join by
invitation (`POST /api/admin/operators/invite`, resend, withdraw): an email
with a link to `/admin/invite.html` where they choose their own password,
valid for seven days, and when the email cannot go the admin is shown the link
instead. A superadmin creating a company must now give the first admin's
address and the same invitation goes out; no address is made up and no
password appears in a response. People sign in with an email or a username,
the login page keeps `?next=`, existing accounts can use Google
(`GOOGLE_SIGNIN_CLIENT_ID/SECRET`), and the product's name on every account
page and email is `PRODUCT_NAME`.

**Opening a page creates nothing.** The widget used to create a conversation,
a contact, a usage count and a webhook on every page view, so an idle visitor
cost a tenant part of their plan and filled the inbox with empty rows. A
conversation is now created on the visitor's first real action - a message,
their details, asking for a person, an upload, leaving a message - and
metering, the contact, the `conversation.started` webhook (which until now
never fired at all, and now also fires for email) and the operators' `new-chat`
all happen at that moment. Until then `session-ready` says `pending: true`.
Reports and the checklist ignore the empty rows older versions left behind.

**Never a dead end.** A model failure used to put an apology in the chat and
stop; a spent AI allowance said "unavailable" and stopped; nobody at the desk
meant "you are in the queue" for ever. Every one of those now goes through one
hand-over (`services/conversation-lifecycle.js`) that records why
(`handoff.reason`: asked for a person, bot could not answer, model error, out
of AI replies, workflow, left a message), tells the operators, assigns
somebody if anyone can take it, and tells the visitor which of three things
happened: somebody has it, somebody will, or nobody can right now and they can
leave an email address instead. The assistant marks an answer it could not
give (a `[[NO_ANSWER]]` marker the prompt asks for), stores it as
`unanswered`, uses the tenant's own `fallback` canned reply when there is one,
and offers "Talk to a person" beside it; the `handoff` canned reply, stored
but never used before, is what the bot says when it passes a visitor on. An
operator who answers a visitor who has since left reaches them by email
(`email-channel.sendFollowUp`), with a line in the transcript saying so, and is
told plainly when outbound email is not configured. Only text a model wrote is
metered as an AI reply: canned replies, fixed workflow messages and failures
are free.

**An inbox that says why somebody is waiting.** The queue shows the real
message count, the last message, a live "waiting 4m" timer and a badge for the
reason, sorts by longest wait, and has Mine (assigned to me) and Waiting
(handed over, nobody holding it). New chats, hand-overs, assignments and
transfers raise a toast naming the visitor with an Open button, plus a desktop
notification and a sound, with an "only when I'm needed" setting. The bell
(`NotificationService.notifyUser`) carries chat assigned or transferred, task
assigned, a rating of 1 or 2, and usage warnings, each with a link. The
transcript shows system lines, the hand-over (reason, when, what they asked),
the unanswered marker and visitors' thumbs. Ending a chat records an outcome
(resolved, needs follow-up, not resolved, spam) and a private note. Only the
person holding a chat can end it, leave it or transfer it; an admin can force
it, after a confirmation that names the holder. Transfer lists admins as well
as operators, shows who is online, and refuses somebody offline or not taking
chats. Read receipts reach the visitor when the holder actually views the
conversation (`operator-read`). Rejoining after a reload comes from the server
per person, silently, rather than from a localStorage list shared by everyone
on that browser. History rows open the conversation, filter by date, channel,
status, handler, rating, outcome and tag, and an ended chat can be answered by
email (`POST /api/admin/chat/:id/follow-up`); deleting one, also removing its
files, and the CSV export (audited, formula-safe, honouring the filters) are
admin-only. People can be merged (audited), exported and erased (the GDPR
routes finally have a screen) and exported as CSV. Tasks: the follow-up
overwrite bug is fixed, reassignment works and notifies, admins can be
assigned, and a task an operator creates fires `task.created` as a workflow's
always did.

**A loop for making the bot better.** Every support product's resolution
rate is bounded by its knowledge, and until now nothing told a tenant what
their bot did not know. **Bot → Unanswered questions** (`GET /api/bot/gaps`)
groups the answers the bot could not give, the ones visitors marked unhelpful,
and the conversations handed over after an answer; a group can be dismissed,
and comes back if it is asked again later. **Add the answer** opens **Teach the
bot** (`POST /api/bot/teach`), which saves the answer as knowledge or as a
canned reply, marks the message corrected (and, when it was taught from an
operator's reply, the bot's failed attempt too), and re-runs the saved tests.
The same dialog is on bot messages in any transcript, and an admin can save an
operator's reply as the bot's answer. **Saved tests** (`/api/bot/tests`, up to
50) turn any exchange in Test your bot into a check - the answer mentions
something, hands over, or cites a source - so a change that breaks an answer
that used to be right is found by the tenant rather than by a customer. Test
your bot itself now shows the passages retrieval found with their scores, the
tools the assistant called, and, when nothing matched or the model could not
answer, exactly what a visitor would have got instead. The persona screen has
a guided builder (the business, the tone, what never to guess at, when to
hand over; kept in `AssistantProfile`), a "Draft from my website" button that
needs a model, and the full prompt in effect, part by part.

**Workflows that share the conversation.** One live workflow used to answer
every message, so a tenant who published an order-status flow lost the
assistant for everything else. A workflow now has a trigger: when the visitor
wants something (described in a sentence, chosen by one classifier call for
all of them with the embedding match as fallback), when a message mentions
certain words, or every message (at most one of those). Several can be live;
a message none of them takes goes to the assistant, and a workflow that
finished last turn does not hold the conversation. Saving a live workflow
makes a draft and visitors keep the live version until it is published again
("Live: v3 · Draft: v4"); drafts save with warnings and only publishing
validates. The plan's workflow limit now counts live workflows, so drafts
cost nothing. In the editor a second branch no longer deletes the first, an
empty canvas is not "replaced", Ctrl+Z in a field undoes text, moderation
strictness works, preview sends history, and run statistics (runs,
completions, hand-overs, errors) are persisted rather than kept in memory and
lost.

**Knowledge that keeps up.** A site crawl runs in the background with progress
("12 of 20 pages") instead of holding a request open for a minute, a re-crawl
drops pages the site no longer has, and a site or a single page can be read
again every week (`recrawlDue`, swept hourly). Pasted text can be edited, each
source says how many answers used it, and the Google Sheets card is hidden
unless `GOOGLE_SHEETS_UI=true` (the code is kept; its rows are still not used
in answers).

**Reports that make the case for paying.** A value report on every plan
(`GET /api/admin/analytics/value`, CSV export, also on Home): conversations
resolved by the bot, by a published and deliberately strict definition (the
visitor wrote, the bot answered, nobody joined or was asked for, the last
answer was not an "I don't know", and the visitor did not rate it 1 or 2);
conversations handed to a person; hours saved at the tenant's own minutes per
conversation; cost per resolution from the plan price; AI replies; and
satisfaction for the bot against people. Deflection now counts a conversation
a person ever joined, operator performance includes ended chats, every number
uses one window and the tenant's timezone, and a metric that failed says
"unavailable" rather than 0%.

**Plans that do not surprise anyone.** Seats are operators, invited ones
included; admins run the account and are not counted. Basic keeps a small
allowance of actions (3) and AI suggestions, since taking both away on the
first paid plan read as a downgrade for paying. Consumption meters
(conversations, AI replies, knowledge) warn by banner, bell and email at 80%
and 100%; capacity meters (seats, live workflows, actions) only when over. An
expired trial says so, invoices come from Stripe, and plan cards no longer list
things that are not built.

**Sessions that can be ended.** Signing out used to sign a person out
everywhere, because a token could only be invalidated by bumping the version
they all share. Each token now has an id; "Sign out" revokes that one
(`RevokedToken`, kept until it would have expired anyway) and "Sign out on
every device" ends them all. Deactivating somebody bumps their version,
disconnects their sockets and returns their chats to the queue; a deactivated
company's people are refused at sign-in, on every request and on the socket,
which re-checks every `SOCKET_REAUTH_MS` (60 s). The widget's origin check is
now per tenant: a domain had only to be registered by *some* tenant to run
*any* tenant's widget, which let a free account wear somebody else's name and
spend their plan. A domain another tenant registered is refused (409
`DOMAIN_TAKEN`).

**A widget that says who is talking.** The header shows the business's name
and logo unless the assistant has been given a name of its own, and after a
person joins, their name "from" the business. The greeting says it is an AI
(EU AI Act, Article 50) in all eleven languages, up to four suggested
questions sit under it, answers carry thumbs, a thumbs-down offers a person,
and "Talk to a person" becomes "Leave a message" when nobody can answer.
Every notice is translated; no raw error reaches a visitor. The pre-chat form
is off by default, a consent checkbox appears when the tenant requires one,
and the privacy link is the tenant's own or absent. Pages can drive it with
`window.ChatWidget` (open, close, toggle, identify, shutdown, and events for
open, close, message and hand-over), calls made before it loads are queued,
and identifying a different person starts a clean session. A proactive message
can appear after a delay on chosen pages, once per visit. Reconnecting no
longer duplicates messages (`clientMessageId`), cards and choices survive a
reload, and right-to-left text works. The settings screen gives a minimal
snippet, so later appearance changes reach installed sites, install tabs for
HTML, WordPress, Shopify and Tag Manager, a desktop and phone preview, and
**Check my site**.

**Email from an address that is delivered.** Channel replies used to go out
`From:` the tenant's own address through our server, which is what forged mail
looks like, and receiving providers treated it so. They now go from
`EMAIL_FROM` as "<Reply as> (via `PRODUCT_NAME`)" with `Reply-To` the
tenant's address; `EMAIL_ALLOW_TENANT_FROM=true` restores the old behaviour
for a deployment whose provider has verified its tenants' domains. The
inbound secret travels in an `X-Inbound-Secret` header (the query string is
still accepted), and the screen shows the inbound URL, when the last email
arrived, setup guidance and a test button.

**A platform the operator can run.** Companies are listed with plan, status,
how they were created, whether the widget is installed and last activity;
usage by tenant lists every company with a month picker, trials ending, those
never installed, and an estimated AI cost (`AI_COST_PER_REPLY`). Many more
actions are audited (company created, updated, deleted, signed up; operator
invited, created, removed; widget domains and key; email settings; teaching;
gap dismissals; reports settings; exports), each described in plain English,
filterable by who did it, and exportable as CSV. Retention previews recompute
as you type; business hours take overnight ranges and closed dates; a person
sets their own name and timezone.

### What was checked in a browser, and what was not

After the pass every scenario from the review was walked in a browser against
a local server. Seen working: sign-up through to Home; pasting knowledge; the
guided persona; Test your bot's explanations of what matched and what a
visitor would get; teaching from an answer, saving it as a canned reply and
the saved test passing; the widget's header, greeting and suggested
questions; a page view creating no conversation; a hand-over arriving in the
queue with its reason; joining, replying and ending with an outcome; a rating,
and a low rating notifying the operator; the unanswered-questions list; the
value report; inviting someone and accepting the invitation; a
keyword-triggered workflow answering its own questions and leaving others to
the assistant; leave-a-message after hours; an email follow-up failing with a
clear message when `EMAIL_HOST` is unset; and a superadmin unable to create a
company without the admin's email.

Not exercised locally, because they need outside services: answer quality with
a real OpenAI key (and with it intent triggers, persona drafting and AI
suggestions as a visitor would meet them), a Stripe checkout, real email
delivery (confirmation, invitation, follow-up and channel replies), and Google
sign-in. The automated suite covers their plumbing with the key blanked and
external calls stubbed; it does not tell us they work against the real
services.

## Working end to end

**A dashboard arranged around the jobs people come to do.** The sidebar used
to list features in the order they were built, with the knowledge base as the
second tab under Settings, email and business hours inside "Install Widget",
and developer settings scattered across three places. It is now grouped:
Inbox (live chats, history, people, tasks), Bot (knowledge, persona and
canned replies, actions, workflows, test your bot), Channels (website widget,
email, business hours), Team (operators, routing), Reports, Account (plan and
billing, data retention, audit log), and Developers (your systems, identity
verification, webhooks, API keys) collapsed by default because none of it is
needed to get a bot answering. (Phase 2 added Booking under Bot, WhatsApp and
Messenger & Instagram under Channels, Connected tools on the Actions screen,
and Clients for an agency's admins.) Personal preferences and the password
moved to a profile menu (**My settings**, which now also holds this device's
notifications). A superadmin, who belongs to no company, sees a Platform area
(companies, usage by tenant, platform audit) instead of tenant screens that
could only fail for them; an operator sees the inbox, reports and their own
settings. Every element is hidden by role rather than shown and refused.

A new company admin lands on a checklist rather than three zeros: add
knowledge, write the persona, test the bot, add the website, install the
widget - each step opens the screen that does it and ticks itself off
(`GET /api/companies/me/setup`). Since 2026-10-22 "tested" and "installed"
tick from what happened - Test your bot used, the widget seen loading on the
tenant's site - rather than from a conversation existing.

**Test your bot** runs the real reply path through `POST /api/bot/test` -
live workflows, canned replies, knowledge, read-only actions - without saving a
conversation, counting usage or writing anything, and shows how each answer
was produced and which sources it drew on. It is a screen of its own and a
drawer beside Knowledge, Persona & replies and Actions, so an admin can change
something and try it without losing their place.

The live inbox is three panes - queue, conversation, customer details - and
one pane at a time on a phone, with a back button. The composer grows with
what is typed (Enter sends, Shift+Enter is a new line) and can send a file;
transcripts show files either side sent and the sources a bot reply cited.
Leaving a conversation names both outcomes - hand back to the bot, or return
to the queue - where a `confirm()` used to make OK and Cancel mean two kinds of
leaving. Every native `confirm()` and `prompt()` in the dashboard and editor is
a proper dialog that says what will happen and marks the dangerous button; a
native dialog also froze the socket while it was open.

The website widget screen has a live preview (the real widget in a
no-side-effects preview mode) that redraws as the admin types, plus the
widget's language and logo. Plan & billing has a button per purchasable plan
that goes to Stripe Checkout, and a link to the Billing Portal for a tenant
already paying.

The code underneath: the dashboard was nineteen classic scripts sharing one
global scope, loaded in a fixed order, with five libraries from a CDN. It is
ES modules under `client/` with explicit imports, one HTTP client
(`client/shared/http.js`) that notices an expired session wherever it
happens, one dialog and toast implementation shared with the workflow editor,
and a section registry (`client/admin/nav.js`) that sets a screen up the first
time it is opened. esbuild bundles each page into `public/dist/`; nothing
third-party is fetched, so the CSP allows no outside origin. Opening every
screen once now stays well inside a trial plan's per-minute API allowance,
which the old boot - every section loaded at once - used to exhaust.
`tests/dashboard-markup.test.js` checks that every id the code looks up
exists, every sidebar link has a section, every section is registered, and no
native dialog has crept back.

**Multi-tenancy.** Each company has a `widgetKey` and an `allowedDomains` list.
The embed snippet carries the key; `services/tenant.js` resolves it (or the
request Origin) to a company, and every conversation is stamped with that
company on creation. A page may run a tenant's widget only from one of that
tenant's own allowed domains, and no two tenants can register the same one.
Operators join a per-company socket room
(`operators:<id>`); superadmins join `operators:all`. REST routes are scoped by
`utils/query.js#companyFilter`.

**Chat.** Widget → WebSocket → conversation persistence → AI reply or operator
hand-off, with a REST fallback at `POST /api/chat/message`. The conversation
is created on the visitor's first action, not when the page loads. Transport
security is TLS between the browser and the server. The widget no longer
claims end-to-end encryption: the server has to read every message to answer
or route it, so the in-browser key exchange it used to do promised something
the design cannot deliver, and it was removed rather than left to mislead.

**Industry neutrality.** Nothing about any particular business is compiled into
the product. A company says who its assistant is (`Assistant` → Persona, or a
workflow's Persona node) and defines its own canned replies, which are matched
to a visitor's message by meaning rather than keyword. A company that
configures nothing gets a plain assistant answering from its knowledge base.

**Visual workflow editor.** `client/workflow-editor/editor.js` — a
dependency-free SVG editor. Create, connect, validate, save, publish (with
hot-swap into the live runtime), unpublish, version history with rollback,
duplicate, rename, delete. Each workflow has a trigger (an intent, keywords,
or every message), and editing a live one makes a draft that visitors do not
see until it is published.

**Workflow runtime.** `services/workflow-compiler.js` compiles the graph to an
execution plan and walks it at request time. Safety and persona prompts are
injected into every LLM node at compile time and cannot be edited out. The
runtime lazily loads a tenant's published workflow on first use, so a restart
does not take every bot offline. `services/reply.js` is the single seam both
the socket handler and the REST fallback go through: a workflow the
conversation is part-way through carries on; otherwise the first live
workflow whose trigger matches answers (keywords, then intent, then the one
that takes every message); otherwise the assistant. A workflow that fails
falls back rather than leaving a visitor with silence.

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
way out to a human. Each carries a trigger, so starting from a template does
not take the assistant away from every other question. There is a test that
they all still validate.

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

`routes/knowledge.js` is the way in, and **Bot → Knowledge** is the
screen: read a whole website, upload a file, import a web page or a PDF, or
paste text straight in; see what is
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

`POST /api/knowledge/crawl` (`{url, maxPages, refreshWeekly?}`) reads a site:
`/sitemap.xml` first (sitemap indexes followed a level), then links from the
pages, breadth first, same origin only, HTML only, capped by
`KNOWLEDGE_CRAWL_MAX_PAGES` (50; a request defaults to 20) and
`KNOWLEDGE_CRAWL_TIME_BUDGET_MS` (60 s). Every fetch — sitemap, pages, every
link a page wrote — goes through `safe-http.js`. Each page becomes its own
`url:` source with its `<title>`, exactly as if it had been imported by hand,
so refresh and delete work per page and a second crawl replaces rather than
doubles. Since 2026-10-22 the crawl runs in the background: the request
answers 202 with a job (`models/knowledge-crawl.js`, one per site) that
`GET /api/knowledge/crawl/:jobId` reports on ("12 of 20 pages"), and once done
lists what was imported, what was skipped and why (not HTML, fetch failed,
time ran out, plan limit) and which pages were removed because the site no
longer has them. A crawl interrupted by a restart is reported as failed rather
than polled for ever. A site or a single page can be read again every week;
the scheduler takes a few due ones each hour. Crawling lives in
`services/knowledge-crawler.js`. Single-URL imports keep the page's `<title>`
too.

Both readers now work. `services/ai.js` retrieves on every assistant reply, so a
company that has imported their material gets answers from it without drawing a
workflow — which is what uploading it implied in the first place. Inside a
workflow, `runLlmNode` sent `step.data.systemPrompt || systemPrompt` where the
left branch was always set by the compiler, silently discarding the knowledge it
had just retrieved; it now sends the built hierarchy.

**Citations.** An assistant reply says which sources it drew on.
`reply.generate()` returns `sources: [{title, url}]` — the sources of the chunks
actually placed in the prompt, one entry per source, best first, at most three;
`url` is null for pasted text and uploaded files. A canned reply, a hand-over
line, an "I don't know" and a workflow reply cite nothing (the workflow
compiler does not report which chunks its knowledge node used). The socket `bot-message` event and the REST
reply carry `sources` next to the text (always an array), the bot message
stores it (`messages[].sources`), operators' `new-message` carries it, and
`GET /api/chat/history` returns it, so a reload shows the citations again.

**"Test your bot".** `POST /api/bot/test` (`{message, history, useWorkflow,
state?, asVerified?, customer?}`, company admin; superadmin names `companyId`)
runs the real reply path — live workflows, canned replies, assistant — for the
tenant and answers `{reply, sources, path: workflow|canned|assistant|fallback,
knowledgeMatched, unanswered, failed, passages?, toolCalls?, choices?, cards?,
escalate?, state?, visitorWouldSee?, warning?}`. `passages` are what retrieval
found, with scores; `asVerified` runs the turn as a signed-in customer. Nothing
is created or counted: no Conversation, no usage meters, no canned-reply use
count, and a workflow runs in the editor preview's simulate mode, so a GET
happens but a task, tag, email, POST or handoff is declined. The one write is
`onboarding.botTestedAt`, at most daily, for the checklist. When the model
cannot answer (always, without `OPENAI_API_KEY`, which also sets `warning`),
`failed` is true and `reply` is what a visitor would actually get instead -
the hand-over line, or the leave-a-message form when nobody is available -
with `visitorWouldSee` saying which and why. The returned `state` lets a
workflow that asked a question be answered on the next turn; identity
variables are stripped from it, as in preview. Saved tests (`/api/bot/tests`)
run through the same path.

**Setup checklist data.** `GET /api/companies/me/setup` answers, from cheap
counts and flags, how far a tenant has got: knowledge sources and chunks,
persona (Assistant persona or a Persona node in a live workflow), allowed
domains, conversations somebody actually started, `widgetSeen` (the widget
fetched its configuration from a page on an allowed domain, recorded at most
once a minute; a conversation still counts for installs older than that
record), `botTested`, active operators and admins (everyone who can answer a
chat; this is not the seat count), a published workflow, email channel and
business hours.

**Knowledge retrieval.** `services/embeddings.js` + `services/vector-store.js`.
Backend is chosen automatically: Qdrant (`QDRANT_URL`), Atlas `$vectorSearch`
(`MONGODB_VECTOR_INDEX`), or MongoDB storage with in-process cosine ranking —
the default, which needs no extra infrastructure. MongoDB is the system of
record in all three, so an external index can always be rebuilt. Vectors carry
the model that produced them and are never compared across models. Sources are
keyed by `(company, sourceId)` so a re-import replaces exactly its own chunks;
what must survive a re-import (a note's original text, the weekly refresh
setting) lives in `models/knowledge-source.js`. PDF (via `pdf-parse`) and web
URL ingestion produce real text. The workflow node's old Google Sheets path
calls an older `google-spreadsheet` API than the one installed and is probably
broken (FUNCTIONALITY_MAP.md §2.5).

**Intent routing.** `services/intent-classifier.js` scores a visitor's message
against each router condition's example phrases by embedding similarity —
cheaper and more deterministic than LLM classification, and easier to author.

**Plans and billing.** `config/plans.js` defines Trial/Basic/Professional/
Agency/Enterprise limits and features (the Agency plan and Professional's
per-resolution option since Phase 2; see above). `services/usage.js` meters
conversations, messages, AI replies (only text a model wrote), uploads,
seats, live workflows, saved actions plus switched-on MCP tools, knowledge
chunks and, for a per-resolution tenant with a cap, resolution spending;
`middleware/quota.js` enforces
them with a 402 carrying the meter, limit and plan. A seat is an operator,
invited or active; admins are not counted. The workflow limit counts live
workflows and is checked at publish, so drafts are free. Warnings go out at
80% and 100% (`services/usage-alerts.js`, hourly, once per meter and month).
Superadmins can change a tenant's plan, grant overage, or set per-company
limit overrides.

**Analytics.** Volume, response time, traffic sources, plus bot deflection,
abandonment, a weekday/hour staffing heatmap, per-operator workload with
median and mean response time, recurring topics, and task throughput.
Advanced metrics are gated on the plan's analytics tier. The value report
(resolved by the bot, hours saved, cost per resolution, satisfaction bot
against people) is on every plan; see 2026-10-22 above.

**People.** A Contact owns conversations across sessions and devices, so an
operator can see what the same customer asked last week. Identity comes in
three strengths - anonymous, self-reported (they typed an email) and verified
- and since Phase 2 a verified contact records how: a JWT or an HMAC the
tenant signed (`verifiedBy: jwt|hmac`), or a code sent to their email
(`email_code`), which counts only for actions marked "email verification is
enough". Only a verified contact is safe to discuss account data against,
and the dashboard shows which is which, how, and which attributes were
signed.

**Email as a second channel.** A mail provider posts to a per-tenant webhook and
the message lands in the same queue, answered from the same composer, attached
to the same Contact — only delivery differs. Replies thread by `In-Reply-To` /
`References` against Message-IDs we have sent, falling back to sender plus
normalised subject for clients that drop the headers on a forward. Quoted
history is stripped so an operator does not read the thread five times. The
inbound URL is public, so every request must carry the company's inbound
secret (in the `X-Inbound-Secret` header; the query string is still
accepted); an unknown company and a disabled channel return the same 404 so
the endpoint cannot enumerate tenants. Replies go out from the platform's
`EMAIL_FROM` under the tenant's name with `Reply-To` the tenant's address,
unless `EMAIL_ALLOW_TENANT_FROM=true`. The same outbound path emails a chat
visitor who left an address and went away.

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
`actions` feature and meter (Trial 5, Basic 3, Professional and Agency 25,
Enterprise unlimited), which since Phase 2 counts switched-on MCP tools
together with saved Actions. An action can say that an email code is enough
verification (`verification: 'email'`). **Bot → Actions** is the screen; **Run once** tries the form as it
stands, saved or not (`POST /api/actions/test`), and each action shows its
last 20 runs and last error, read from the audit log
(`GET /api/actions/:id/runs`).

**Satisfaction.** A visitor is asked to rate the conversation once it ends, if
they wrote at least once; declining is remembered so nobody is asked twice. A
score of 1 or 2 notifies the operator who handled it, or the admins if the bot
did. The score is recorded on the first tap and a comment box only then
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
disconnecting. Everyone busy is a normal outcome: the conversation waits in
the queue, and the visitor is told so rather than left watching an empty
window. Nobody there at all - closed, or nobody online and taking chats - is a
different one: promising "someone will be with you shortly" then is how a
visitor waits for a reply that never comes, so the widget asks for an email
address instead and the conversation waits with the reason "left a message".
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

**Availability.** Per-company business hours in the company's own timezone,
including overnight ranges and whole closed dates (bank holidays). Outside
them the widget stops implying someone is about to answer and offers to take
a message. Whether an
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
downloads served as attachments with `nosniff`. Files travel both ways: an
operator sends one with `POST /api/admin/conversations/:sessionId/files`
(same allowlist and cap, delivered as an `operator-message` carrying
`fileId`/`fileName`/`fileUrl`), and the visitor downloads it with their
session id and token on the URL, since the session cookie is third-party on
the tenant's site. Raster images can be fetched inline (`?inline=1`) for a
thumbnail.

**Taking payment.** A company admin starts a Stripe Checkout Session for any
plan with a configured price (`POST /api/billing/checkout`) or opens the
Billing Portal (`POST /api/billing/portal`); the webhook still decides what
the tenant is entitled to. Invoices are listed from Stripe
(`GET /api/billing/invoices`). REST calls through axios, no Stripe library.

**Widget languages and branding.** Every visitor-facing string, aria labels
included, is translated into English, Spanish, French, German, Italian,
Portuguese, Romanian, Russian, Ukrainian, Polish and Dutch. The language is
the snippet's `data-language`, else the tenant's `widgetSettings.language`,
else the browser's, else English (`auto` means the browser). An optional
https `logoUrl` appears in the header. Bot replies show a "Sources" line when
the message carries `sources`. The pre-chat form hides the composer, and
"Talk to a person" appears only once the conversation has started. The
dashboard's appearance preview loads `/widget/preview.html`, which runs the
widget with no socket, session, config fetch or usage.

**Operations.** `/health` and `/ready`, Prometheus metrics at `/metrics`,
graceful shutdown, MongoDB-backed sessions, helmet + CSP, rate limiting,
content-hashed widget assets cached for a year with the loader on `no-cache`.
Background jobs are gated by `SCHEDULER_ENABLED` so a multi-instance
deployment runs them once. There is a `Dockerfile`, a Compose file that runs
the app with MongoDB 7, and CI that runs lint, tests, `npm audit` and the
image build on every push. The first superadmin - the platform operator - is
created through `POST /api/auth/create-superadmin`, which works only while no
user exists; customers sign themselves up or are invited. The scheduler also
refreshes knowledge due its weekly read (hourly at :15) and sends usage
warnings (hourly at :45), and since Phase 2 alerts the team about long waits
(every minute), sends booking reminders (every 15 minutes), ends idle web
chats (hourly at :05), counts resolutions (01:15) and reports them to Stripe
(01:30). The workflow runtime writes its run counts on shutdown.

## Known gaps

- **None of the Phase 2 integrations has met the real service.** Meta,
  Cal.com, Google Calendar, Calendly, Stripe's Billing Meter, MCP servers,
  push services and the WordPress and Shopify installs are tested against
  stubs only.
- **Nothing bills for overage, or for an agency's extra clients.**
  `overageAllowed` lets a tenant exceed their plan and nothing charges for
  what it let through; clients beyond an agency's included ones are counted
  and shown, not billed. (Putting a client on the paid client plan needs the
  agency's own Agency plan to be active and paid; an agency on a trial adds
  clients on their own trials.)
- **Messaging apps are text and pictures in, text out.** An operator cannot
  send a file to a WhatsApp, Messenger or Instagram customer, no typing
  indicator is sent, and the short notices the platform sends there (a
  hand-over, for instance) are in English. With several instances, two
  messages from one customer arriving at once on different instances are
  not ordered against each other (the lock is per process), so the bot can
  answer both at once; a unique index keeps them in one conversation.
- **MCP tools cannot be used from workflows, and OAuth servers cannot be
  connected.** "Workflow only" on a tool therefore means unused for now. A
  tool's "verified customers only" needs a signed visitor; an email code is
  not enough.
- **Signed attributes are shown, not used.** A JWT's `attrs` are stored and
  shown in People, but an action input can take only the verified id, email,
  name or phone, and workflows do not see them.
- **Booking reminders are in English**, and a Cal.com account must be on
  Cal.com's own cloud: the API address is fixed.
- **A crawl follows no robots.txt and reads no JavaScript.** It reads the HTML
  a server returns, so a site rendered in the browser yields little text. It
  is same-origin by the address it was asked for; a page that redirects
  off-site is followed (through the same address checks) and imported under
  the address that was asked for. Crawls run in the web process rather than a
  queue, so a restart interrupts one (it is then reported as failed).
- **Workflow replies carry no citations.** The compiler's knowledge node does
  not report which chunks it used, so `sources` is always empty for them.
- **"Test your bot" and saved tests run real model and GET calls.** Those
  cost what they cost (they are not metered against the tenant's plan, but
  OpenAI bills them; fifty saved tests are fifty model calls a run). Persona
  changes reach it after the assistant-config cache (60 s), canned replies
  immediately.
- **An operator reply sent in the seconds before the server notices the
  visitor left goes to the chat, not by email.** The switch to email is made
  on whether the visitor still has a socket in their room, and a connection
  that drops rather than closes lingers until the socket's ping timeout. The
  reply is in the transcript; it is just not emailed.
- **Email and messaging-app threads never end on their own.** Since Phase 2
  an idle web chat is ended after `IDLE_CLOSE_HOURS` and fires
  `conversation.ended`; an email or app thread is left open, because its next
  message belongs to the same thread, so it fires only when an operator ends
  it.
- **Scanned PDFs yield no text.** `pdf-parse` reads a PDF's text layer; a
  scanned document has none. OCR would need an additional service.
- **In-process vector ranking scans a tenant's chunks** rather than using an
  ANN index. It logs a warning above 20,000 chunks per tenant, at which point
  `QDRANT_URL` or `MONGODB_VECTOR_INDEX` should be configured.
- **Intent matching without an API key falls back to lexical overlap.** With
  `OPENAI_API_KEY` set it is genuinely semantic; without it, "money back" will
  not reach a "refund" intent. The same holds for choosing a workflow by its
  intent trigger, which without a key falls back to the same lexical scoring
  against a stricter threshold.
- **Topic analysis is term frequency**, not clustering. It answers "what are
  people asking about" but will not group synonyms.
- **The connector covers catalogue and appointments only** (listing,
  booking and, since Phase 2, cancelling). Carts, checkout and order lookup
  are the obvious next capabilities; the contract and SDK are shaped so
  adding one is a new entry in `config/capabilities.js` and a method in the
  SDK rather than new plumbing.
- **Write confirmation is lexical.** A write runs only when the model repeats
  the identical call in a later turn after a reply that matches a short list of
  affirmatives ("yes", "ok", "go ahead"…, with no negation). That is
  deliberately strict and deterministic, but a confirmation in another
  language, or phrased unusually, is read as "not yet" and the visitor has to
  say yes plainly.
- **A workflow cannot call another workflow**, and there is no loop construct.
  Both are deliberate for now: cycles are rejected at design time because the
  executor walks the graph, and a conversation that loops is almost always a
  bug rather than an intention.
- **The dashboard is English only**, although the widget speaks eleven
  languages.

The longer list of what is not built - store listings for the plugins,
Meta's and Google's reviews, SOC 2, an EU region, workflow loops, dashboard
translation - is in [todo.md](todo.md).

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

`npm test` — 1,976 passing and 2 skipped across 114 suites (2026-10-22, after
Phase 2; the skipped two check the WordPress plugin's PHP and need `php` on
the path). An in-memory MongoDB 7
starts automatically (`tests/globalSetup.js`, wiredTiger in a throwaway
directory, a native build on Apple Silicon), so no local `mongod` is needed.
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
  (The file name `models/knowledge-source.js` was reused in October 2026 for
  an unrelated model: per-source settings that survive a re-import.)
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
