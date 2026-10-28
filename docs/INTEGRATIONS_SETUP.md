# Setting up integrations

_Written 2026-10-22 for the second implementation pass. Read from the code on
`production-readiness`; the dashboard screens named here are the ones in
`public/admin/index.html`._

This is for the person doing the setup: the platform operator (whoever runs
this deployment) in part 1, and a tenant's admin in part 2. Each step says
where it happens. Steps marked **On Meta's side**, **On Google's side**,
**On Stripe's side**, **In Cal.com**, **In Calendly**, **In WordPress** or
**In Shopify** happen in someone else's product, whose menus move; if a label
here no longer matches, look for the same idea nearby.

> **None of these third parties was exercised live in this pass.** The code
> paths are covered by the automated suite against stubbed APIs, and the
> dashboard screens were checked in a browser, but no real Meta app, Google
> project, Stripe meter, Cal.com or Calendly account, MCP server, push
> service, WordPress site or Shopify store has been connected yet. Expect the
> first real setup of each to turn something up, and note what it was.

Contents

1. [For the platform operator](#1-for-the-platform-operator)
   - [1.1 What every integration below assumes](#11-what-every-integration-below-assumes)
   - [1.2 Push notifications (VAPID keys)](#12-push-notifications-vapid-keys)
   - [1.3 A Google OAuth client for Google Calendar](#13-a-google-oauth-client-for-google-calendar)
   - [1.4 Stripe: plans, the Agency plan and per-resolution pricing](#14-stripe-plans-the-agency-plan-and-per-resolution-pricing)
   - [1.5 Making a company an agency](#15-making-a-company-an-agency)
2. [For a tenant](#2-for-a-tenant)
   - [2.1 Booking: Cal.com, Google Calendar or Calendly](#21-booking-calcom-google-calendar-or-calendly)
   - [2.2 WhatsApp](#22-whatsapp)
   - [2.3 Messenger and Instagram](#23-messenger-and-instagram)
   - [2.4 Signed identity for logged-in visitors](#24-signed-identity-for-logged-in-visitors)
   - [2.5 Email-code verification](#25-email-code-verification)
   - [2.6 The WordPress plugin](#26-the-wordpress-plugin)
   - [2.7 Shopify](#27-shopify)
   - [2.8 MCP servers (connected tools)](#28-mcp-servers-connected-tools)
   - [2.9 Installing the operator app](#29-installing-the-operator-app)

---

## 1. For the platform operator

### 1.1 What every integration below assumes

- **`PUBLIC_URL` is the HTTPS address customers reach.** Meta will not call
  an `http://` webhook or one with a self-signed certificate; Google
  redirects back to an address built from it; the callback URLs the dashboard
  shows tenants are built from it. Behind a proxy, set `TRUST_PROXY` too.
- **`SECRETS_KEY` is set, and will not change.** Every credential tenants
  paste in below (Meta tokens and app secrets, Cal.com and Calendly keys,
  Google refresh tokens, MCP credentials) is encrypted with it. Without it
  the key is derived from `SESSION_SECRET`, and rotating that makes all of
  them unreadable, so every tenant would have to connect everything again.
- **`EMAIL_HOST` and `EMAIL_FROM` are set** (the email channel's outbound
  server, not the platform's `SMTP_*`). Two features here send mail to a
  tenant's customers through it: the six-digit verification code (2.5) and
  the appointment reminder a day before a booking (2.1). Without it the code
  is refused with "Email verification isn't available right now" and
  reminders are skipped; nothing else breaks.
- **One instance runs the scheduler** (`SCHEDULER_ENABLED=true` on exactly
  one). Booking reminders, the long-wait alert, idle close and the nightly
  resolution count and Stripe report all run there.

### 1.2 Push notifications (VAPID keys)

Push is what reaches an operator whose dashboard is closed: the phone in a
receptionist's pocket. It is off until the deployment has a VAPID key pair,
and the dashboard says so ("Push notifications are not set up on this
server").

1. Generate the keys once, on any machine with this repository:

   ```sh
   node scripts/generate-vapid-keys.js ops@yourcompany.com
   ```

   It prints three lines. The address is how a browser maker's push service
   (Google, Apple, Mozilla, Microsoft) contacts whoever runs the deployment
   about abuse; it becomes `mailto:ops@yourcompany.com`. An `https:` URL also
   works.
2. Put the three lines in the environment:

   ```
   VAPID_PUBLIC_KEY=...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:ops@yourcompany.com
   ```

   All three or nothing: with any one missing, push stays off.
3. Make sure the `web-push` package is installed (`npm install`; it is in
   `package.json` as `^3.6.7`). Without it the server logs "Push
   notifications are off: the web-push package is not installed" and carries
   on without push.
4. Restart. In the dashboard, **My settings → Notifications on this device**
   now offers **Turn on notifications** and **Send a test**.

Keep the private key as secret as `JWT_SECRET`, and do not rotate it
casually: every device subscribed under the old public key stops receiving
notifications until its owner next opens the dashboard and it subscribes
again.

What a notification carries is deliberately little, because it passes
through the browser maker's service and lands on a lock screen: who is
waiting, and, only on a device whose owner switched **Show message previews**
on, a short preview of what they wrote.

### 1.3 A Google OAuth client for Google Calendar

Tenants connect Google Calendar by signing in with Google; that needs an
OAuth client belonging to the deployment. Cal.com and Calendly need nothing
from you: tenants paste their own key.

This is a separate client from Google sign-in (`GOOGLE_SIGNIN_*`) and can be
separate from the Sheets import (`GOOGLE_CLIENT_*`). If
`GOOGLE_CALENDAR_CLIENT_ID` and `_SECRET` are unset, the Sheets client's id
and secret are used; the redirect is never shared.

**On Google's side** (Google Cloud console):

1. Create a project, or pick the one you use for the platform.
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **OAuth consent screen**: user type **External**; the app name tenants
   will see (your `PRODUCT_NAME`); a support email; your domain under
   authorised domains.
4. **Scopes**: add exactly these two.
   - `https://www.googleapis.com/auth/calendar.events` (to add the
     appointment)
   - `https://www.googleapis.com/auth/calendar.readonly` (free/busy and the
     calendar's timezone)

   Both are "sensitive" scopes. Until Google has verified the app, only the
   test users you list can connect, and they see an "unverified app"
   warning; Google also documents that refresh tokens issued to an app in
   **Testing** status expire after seven days, after which the tenant's
   calendar stops answering until they connect again. For production, submit
   the app for verification (a privacy policy, a demonstration of the scopes
   in use) and publish it.
5. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Under **Authorised redirect URIs** add exactly:

   ```
   https://your-host/api/booking/google/callback
   ```

   (`PUBLIC_URL` + `/api/booking/google/callback`.)

**On our side**:

```
GOOGLE_CALENDAR_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CALENDAR_CLIENT_SECRET=...
# Only if the redirect registered above is not PUBLIC_URL + /api/booking/google/callback:
GOOGLE_CALENDAR_REDIRECT_URI=https://your-host/api/booking/google/callback
```

Restart. **Bot → Booking** now offers **Connect Google Calendar**; without
the client the card explains instead, and `POST /api/booking/google/start`
answers 503.

### 1.4 Stripe: plans, the Agency plan and per-resolution pricing

The flat plans work as before (README, "Taking payment"): one Stripe price
per plan, `STRIPE_PRICE_BASIC`, `_PROFESSIONAL`, `_ENTERPRISE`, plus
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Two things are new.

**Every price is a placeholder until you decide it.** The figures the
dashboard shows come from the environment; the defaults in brackets are what
`config/plans.js` uses when a key is unset. Stripe charges what the Stripe
price says, so the two must agree.

| Key | Default | What it is |
| --- | --- | --- |
| `PLAN_AGENCY_PRICE` | 299 | The Agency plan, per month |
| `PLAN_AGENCY_CLIENTS_INCLUDED` | 10 | Client companies included in it |
| `PLAN_AGENCY_CLIENT_PRICE` | 19 | Each client beyond those, per month (shown, not yet billed) |
| `PLAN_AGENCY_CLIENT_LIMIT` | 50 | Most clients one agency may hold unless you set its own limit |
| `PLAN_AGENCY_CLIENT_PLAN` | professional | The plan a client goes on when the agency pays for it |
| `PRICE_PER_RESOLUTION_BASE` | 49 | Professional paid per resolution: the monthly base fee |
| `PRICE_PER_RESOLUTION` | 0.49 | Price of one resolution |
| `PRICE_INCLUDED_RESOLUTIONS` | 0 | Resolutions free each month |

**The Agency plan.** **On Stripe's side**, create a product "Agency" with a
recurring monthly price of `PLAN_AGENCY_PRICE`. Set its id as
`STRIPE_PRICE_AGENCY`. The plan is offered only to companies you have made
agencies (1.5); buying it does not make a company one.

**Professional, paid per resolution.** A resolution is a conversation the bot
resolved by the value report's published definition, counted once the
conversation has ended or sat idle for a day (so it can no longer turn into a
hand-over). Every night at 01:15 each company's month is counted; at 01:30
the day's difference is reported to a Stripe Billing Meter. The tenant can
set a monthly spending cap: past it, resolutions are not reported, and the
bot keeps answering.

**On Stripe's side**:

1. **Billing → Meters → Create meter.**
   - Event name: `resolutions` (or whatever you set as
     `STRIPE_RESOLUTION_EVENT`).
   - Aggregation: **Sum**.
   - Customer mapping: the payload key `stripe_customer_id` (Stripe's
     default). Value key: `value` (Stripe's default). These are the keys the
     code sends.
2. Create a product "Resolutions" with a **usage-based** price on that meter,
   per unit, at exactly `PRICE_PER_RESOLUTION`, monthly, **with no free tier
   of its own**: the included resolutions and the cap are already taken off
   before the number reaches Stripe. Its id is `STRIPE_PRICE_RESOLUTION`.
3. If the base fee is not 0, create a recurring monthly price of
   `PRICE_PER_RESOLUTION_BASE` (on the Professional product or one of its
   own). Its id is `STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION`. With a base
   fee and no price for it, the per-resolution checkout is not offered.
4. Leave Stripe's invoice finalisation grace period at its default (about 72
   hours) or longer. A conversation from the last evening of a month settles
   a day later and is still reported against that month for the first three
   days of the next; a shorter grace would close the invoice first.
5. On the webhook endpoint you already have, keep `checkout.session.completed`,
   `customer.subscription.created`, `.updated`, `.deleted`,
   `invoice.payment_succeeded` and `invoice.payment_failed`.

**On our side**:

```
STRIPE_PRICE_AGENCY=price_...
STRIPE_PRICE_RESOLUTION=price_...
STRIPE_PRICE_PROFESSIONAL_PER_RESOLUTION=price_...
STRIPE_RESOLUTION_EVENT=resolutions
```

Without `STRIPE_SECRET_KEY` and `STRIPE_PRICE_RESOLUTION`, resolutions are
still counted and shown on **Plan & billing**, and nothing is sent to Stripe.

How it fits together: a per-resolution checkout puts the base-fee price and
the metered price on one subscription, carrying `metadata.pricingModel =
per_resolution`, anchored to the first of next month (our months are calendar
months in UTC). Each daily report is a meter event whose `identifier` and
`Idempotency-Key` are `res_<company>_<YYYY-MM>_<day>`, so a retried report is
counted once. A superadmin can also switch a tenant to per resolution from
the plan dialog (`pricingModel` on `PATCH /api/billing/companies/:id/subscription`).

Two things to check on the first real month, because neither has been tried
against Stripe: that the meter's total matches the count on the tenant's
**Plan & billing** screen, and what happens when a tenant lowers the cap
below what was already reported. The code then reports a negative difference
for the day; confirm the meter accepts it, or that the invoice is right
anyway.

**Not billed yet:** clients beyond those an agency's plan includes are
counted and shown on its **Clients** screen, but nothing charges for them.

### 1.5 Making a company an agency

An agency is an ordinary company that runs support desks for its own
clients. Only a superadmin can make one.

1. **Platform → Companies**, find the company, **Make agency**. Optionally
   set its own client limit (otherwise `PLAN_AGENCY_CLIENT_LIMIT`). A company
   that is itself another agency's client cannot become one until it is
   removed from that agency.
2. Its admins now see **Clients** in the sidebar. From there they add a
   client (a new company and an invitation to its first admin, sent under
   the agency's brand), open a client's dashboard, and remove a client.
3. For its own brand on its clients' dashboards, sign-in and invitation pages
   and platform emails, the agency needs a plan with `customBranding`: the
   Agency plan (or Enterprise). It sets the brand on **Clients**: a product
   name, an `https://` logo, a colour and a support address.

What working in a client's dashboard means: **Open client dashboard** issues
a one-hour token scoped to that client. A banner says whose dashboard it is
and leads back. Every request made with the token, reads included, is written
to the client's audit log as `agency.acted_as`, so a client can see what its
agency looked at. Billing is refused while working as a client: paying is
between the client and whoever pays. **Stop agency** keeps the clients
attached but stops anyone opening their dashboards, and they go back to the
product's brand until it is switched on again.

An agency can put a client on the paid client plan only once its own Agency
plan is active and paid. While the agency is on a trial, or on another plan,
its new clients start on their own trials.

---

## 2. For a tenant

### 2.1 Booking: Cal.com, Google Calendar or Calendly

Connecting the diary you already keep lets the bot offer real free times and
book the one a customer picks, instead of taking a preferred time for
somebody to call back about. It books from the **Book or change an
appointment** workflow template and whenever a customer asks the assistant.
The customer confirms before anything is booked, nothing is ever booked from
**Test your bot** or the workflow preview, and one conversation cannot hold
more than three upcoming appointments.

Booking needs a plan with actions (every plan has them). Connect one calendar
at a time under **Bot → Booking**.

#### Cal.com

Cal.com keeps your event types, availability (working hours, buffers,
minimum notice, other calendars it checks) and confirmation emails; the bot
books straight into it. Cal.com's own cloud (`api.cal.com`) only: a
self-hosted Cal.com cannot be connected yet.

1. **In Cal.com**: **Settings → Developer → API keys → Add**. Give it a name
   ("Support bot") and no expiry, or a long one; copy the key (`cal_live_…`).
2. **In the dashboard**: **Bot → Booking → Cal.com**, paste the key,
   **Connect Cal.com**. Your event types are listed.
3. Untick any event type the bot must not book (an internal meeting, say).
   **Fetch event types again** after you add one in Cal.com.
4. **Test: show the next 3 slots.** It reads; nothing is booked.
5. Make sure **Let the bot book** is on.

#### Google Calendar

Google knows nothing about appointments, only events, so you describe your
services and opening hours here and the bot works out free times from your
calendar's free/busy. Your deployment's operator must have set up a Google
OAuth client (1.3); without it the card says so.

1. **In the dashboard**: **Bot → Booking → Connect Google Calendar**. Sign in
   with the Google account whose calendar takes the appointments and allow
   both permissions (adding events, reading free/busy). You come back to the
   Booking screen.
2. **Add a service** for each thing customers book: name, duration (5 to 480
   minutes) and a buffer before and after (0 to 240).
3. **Opening hours for appointments**: the days and times you take bookings.
   Free times are these hours, minus what is already in the calendar, minus
   each service's buffer either side, in your business timezone. The
   timezone and closed dates come from **Channels → Business hours**: set
   the timezone there first.
4. **Minimum notice** (default 2 hours), **Look ahead** (default 14 days),
   and which **Calendar** (`primary`, or another calendar's ID from its
   settings in Google Calendar).
5. Optional: **Add the customer to the event as a guest**, so Google emails
   them an invitation.
6. **Test: show the next 3 slots.** Before booking, the bot checks the time
   is still free.

If Google says the app is unverified, your deployment's Google app has not
been through Google's verification yet; ask whoever runs it.

#### Calendly

Calendly keeps the event types and availability. What the bot can do depends
on your Calendly plan.

1. **In Calendly**: **Integrations → API & webhooks → Personal access
   tokens → Generate new token**. Generate it as the account owner or an
   admin. Copy it; Calendly shows it once.
2. **In the dashboard**: **Bot → Booking → Calendly**, paste the token,
   **Connect Calendly**, untick event types the bot must not book, **Test**.

On a **paid Calendly plan** (Standard and up) the bot books directly through
Calendly's Scheduling API and Calendly sends its usual confirmation. On the
**free plan**, Calendly's API cannot book, so the bot sends the customer a
single-use booking link with their name, email and chosen day already filled
in; the widget shows it as a **Finish booking** button. The same happens for
an event type whose location the customer has to choose, and when there is
no email to book under. A link booking shows as pending in **Upcoming
bookings** and raises no `booking.created` webhook, because we cannot tell
whether they finished it. Calendly cannot move a booking through its API, so
moving one books the new time and then cancels the old.

#### After connecting, whichever calendar

- **Upcoming bookings** on the same screen lists what the bot booked; an
  operator can cancel or move one from there (`/api/booking/bookings`).
- A customer can cancel in the chat by giving the booking reference, from the
  conversation they booked in or by giving the email it was booked under.
- **Email the customer a reminder about a day before** (on by default) sends
  one reminder per booking, about 24 hours ahead, through your deployment's
  outbound email. Not for bookings made less than 12 hours before the
  appointment, nor for customers who gave no email. The reminder is in
  English.
- Each booking and cancellation raises the `booking.created` /
  `booking.cancelled` webhook (Developers → Webhooks) and is in the audit
  log.
- The **Book or change an appointment** template offers real free times as
  buttons once a calendar is connected, and falls back to raising a task for
  whoever runs the diary when nothing is connected or nothing is free.
- Disconnecting forgets the credentials (for Google, the token is revoked
  too). Bookings already made stay in your calendar.

### 2.2 WhatsApp

Messages to your WhatsApp Business number land in the same inbox as chat, are
answered by the same bot, and are handed to your team the same way. Replies
go back on WhatsApp. Available on the trial, Professional, Agency and
Enterprise plans (not Basic).

You need the WhatsApp **Cloud API** through a Meta app you own. Allow an
afternoon for the Meta side the first time.

**On Meta's side**:

1. In **Meta for Developers** (developers.facebook.com), **Create app**, type
   **Business**, connected to your business portfolio. Add the **WhatsApp**
   product.
2. In **WhatsApp Manager**, add your business phone number and verify it by
   SMS or call. Note its **Phone number ID** and your **WhatsApp Business
   Account ID** (both on the app's **WhatsApp → API Setup** page). The phone
   number ID is a long number that is not the phone number itself.
3. A token that does not expire: in **Business settings → Users → System
   users**, add a system user (Admin), **Assign assets**: the app and your
   WhatsApp account, with full control. **Generate new token** for the app,
   expiry **Never**, with the permissions `whatsapp_business_messaging` and
   `whatsapp_business_management`. Copy it.
4. The app secret: in the app, **App settings → Basic → App secret → Show**.
   It is what proves a webhook came from Meta.

**In the dashboard**: **Channels → WhatsApp**. Paste the phone number ID, the
WhatsApp Business Account ID (optional), the number customers see
(optional), the token and the app secret. **Save**. The screen now shows a
**callback URL** (`PUBLIC_URL/api/channels/webhook/whatsapp`) and a **verify
token**.

**On Meta's side** again:

5. In the app, **WhatsApp → Configuration → Webhook → Edit**: paste the
   callback URL and the verify token, **Verify and save**. The dashboard's
   status changes once Meta's check reaches us.
6. **Webhook fields → Manage**: subscribe to **messages**.
7. In WhatsApp Manager, add a payment method: Meta bills template messages.
8. Switch the app to **Live**. Meta may ask for business verification before
   the number can message beyond its starting limits.
9. Optional, for answering after 24 hours: create a message template,
   category **Utility** (say `follow_up`: "Hello {{1}}, we have replied to
   your question. Reply here to continue."). Once Meta approves it, enter its
   name and language in the dashboard and say where the customer's name goes
   (`{{1}}`, a named parameter, or nowhere).

**Check it works**: write to your business number from your own phone. The
message appears under **Live chats** with a WhatsApp badge and the bot
answers. **Send a test message to my number** works only to a phone that has
written to the business number in the last 24 hours.

**The 24-hour rule.** WhatsApp allows a free reply only within 24 hours of the
customer's last message. The composer shows how long is left. After that an
operator can send only the approved template, which invites the customer
back; free text is refused rather than lost. Customers' images and documents
arrive in the transcript; sending a file to a WhatsApp customer is not
supported yet, nor are typing indicators, and the short notices the platform
sends on WhatsApp (a hand-over, for instance) are in English.

**If the webhook verifies but no messages arrive**, check that the WhatsApp
Business Account is subscribed to the app (Meta's documentation:
`POST /<WABA-ID>/subscribed_apps` with the system user's token), that the
`messages` field is subscribed, and that your plan includes the channels
(the WhatsApp screen says so; a webhook for a plan without them is
acknowledged and dropped, with the reason shown on the screen).

**Disconnect** forgets the token and app secret. **Make a new verify token**
replaces the token Meta checks; paste the new one into Meta afterwards.

### 2.3 Messenger and Instagram

Messages to your Facebook Page, and Instagram Direct messages to the
Instagram professional account linked to it, land in the same inbox and are
answered by the same bot. One form, because Instagram is reached through the
Page with the Page's token; two inboxes, because they are two channels. Same
plans as WhatsApp.

**On Meta's side**:

1. A Facebook Page, and for Instagram a **professional** (business or
   creator) Instagram account **linked to that Page** (Meta Business Suite →
   Settings).
2. In the **Instagram app**: **Settings → Messages and story replies →
   Message controls → Connected tools → Allow access to messages**. Without
   it Instagram does not pass messages on.
3. In Meta for Developers, a **Business** app (the same one as WhatsApp is
   fine) with the **Messenger** product, and the Instagram messaging setup
   for Instagram Direct.
4. A **Page access token** with `pages_messaging`, `pages_manage_metadata`,
   `pages_show_list`, and for Instagram `instagram_basic` and
   `instagram_manage_messages`. A Page token taken from a short-lived user
   token expires within the hour; exchange the user token for a long-lived
   one first (a Page token from a long-lived user token does not expire), or
   generate the token for a system user that has the Page assigned.
5. The **App secret** (App settings → Basic).
6. The IDs: the **Page ID** (Page → About → Page transparency, or the app's
   Messenger settings) and, for Instagram, the **Instagram account ID**
   (Graph API: `GET /<page-id>?fields=instagram_business_account`).

**In the dashboard**: **Channels → Messenger & Instagram**. Paste the Page ID,
the Instagram account ID (leave it empty for Messenger only), the token and
the app secret. **Save**. The screen shows two callback URLs
(`…/api/channels/webhook/messenger` and `…/api/channels/webhook/instagram`)
and one verify token.

**On Meta's side** again:

7. Set the **Messenger** webhook to the Messenger callback URL and the
   Instagram one to the Instagram callback URL, both with the verify token.
   Subscribe to **messages** and **messaging_postbacks**, and subscribe the
   Page to the app.
8. **App Review**: before anyone outside your app's roles can reach the bot,
   Meta must grant `pages_messaging` (and `instagram_manage_messages`) at
   **Advanced Access**, which needs business verification. Until then only
   people with a role on the app get answers.
9. Optional: request the **Human Agent** permission in App Review. Only once
   it is granted, tick **Meta has approved this app for the Human Agent
   permission** in the dashboard. It lets an operator answer up to seven
   days after the customer last wrote instead of 24 hours; Meta refuses the
   tag otherwise.
10. Switch the app to **Live**.

**Check it works**: message your Page (and your Instagram account) from an
account that has a role on the app. It appears under **Live chats** with its
badge. Buttons the bot offers arrive as Messenger quick replies.

The 24-hour rule applies here too, with no template: after 24 hours the
composer refuses free text unless the Human Agent tag is approved, and then
only up to seven days.

### 2.4 Signed identity for logged-in visitors

If your customers log in to your site, your server can tell the widget who
they are. A verified visitor's conversations attach to the right person in
**People**, your team sees them marked verified, and the assistant may use
the actions and connected tools you marked "verified customers only", with
the customer's id filled in from the proof rather than from anything typed.

Your server signs a short-lived token (a JWT) with your **identity secret**.
The secret is under **Developers → Identity verification**, with these same
examples filled in with your widget key. It must never reach a browser: sign
on your server, per page or per request.

**The token** (HS256 only):

| Claim | Required | What it is |
| --- | --- | --- |
| `sub` | yes | Your id for the user. Becomes the contact's external id. Up to 255 characters. |
| `exp` | yes | Expiry, in seconds. At most 24 hours after `iat` (or after now, without `iat`); one hour is a good choice. |
| `iat` | no | Issued at. Must not be in the future. |
| `nbf` | no | Not before. |
| `aud` | no, recommended | Your widget key. When present it must match, so a token made for some other use of the same secret is not accepted. |
| `email`, `name` | no | Shown to your team as verified. |
| `attrs` | no | An object of details you vouch for (a plan, an account number): up to 50, names of letters, digits, `_` and `-`, values up to 500 characters. Shown in People as signed. |

A minute of clock difference either way is tolerated. A token that fails any
check is not an error the visitor sees: they simply chat as a guest.

**Node.js**

```js
// npm install jsonwebtoken
const jwt = require('jsonwebtoken');

const userJwt = jwt.sign(
  {
    sub: String(user.id),
    email: user.email,
    name: user.name,
    aud: 'YOUR_WIDGET_KEY',
    attrs: { plan: user.plan }
  },
  process.env.CHAT_IDENTITY_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' }
);
```

**Python**

```python
# pip install pyjwt
import time, jwt

now = int(time.time())
user_jwt = jwt.encode({
    "sub": str(user.id),
    "email": user.email,
    "name": user.name,
    "aud": "YOUR_WIDGET_KEY",
    "attrs": {"plan": user.plan},
    "iat": now,
    "exp": now + 3600,
}, CHAT_IDENTITY_SECRET, algorithm="HS256")
```

**PHP**

```php
// composer require firebase/php-jwt
use Firebase\JWT\JWT;

$now = time();
$userJwt = JWT::encode([
    'sub' => (string) $user->id,
    'email' => $user->email,
    'name' => $user->name,
    'aud' => 'YOUR_WIDGET_KEY',
    'attrs' => ['plan' => $user->plan],
    'iat' => $now,
    'exp' => $now + 3600,
], getenv('CHAT_IDENTITY_SECRET'), 'HS256');
```

**Ruby**

```ruby
# gem install jwt
require 'jwt'

now = Time.now.to_i
user_jwt = JWT.encode({
  sub: user.id.to_s,
  email: user.email,
  name: user.name,
  aud: 'YOUR_WIDGET_KEY',
  attrs: { plan: user.plan },
  iat: now,
  exp: now + 3600
}, ENV['CHAT_IDENTITY_SECRET'], 'HS256')
```

**Give it to the widget**, on pages for a logged-in user:

```html
<script
  src="https://your-server/widget/js/widget-loader.js"
  data-widget-key="YOUR_WIDGET_KEY"
  data-server-url="https://your-server"
  data-user-jwt="<%= userJwt %>"
  defer></script>
```

or from JavaScript, for a site that signs people in without a page load:
`ChatWidget.identify({ jwt: userJwt })`. On sign-out, `ChatWidget.shutdown()`.

**Refresh it before a long visit outlives it.** When the token runs out the
server treats the visitor as a guest and the widget fires `identity-expired`.
Listen for it, fetch a fresh token from an endpoint of yours, and hand it
over; the visitor need not notice:

```js
ChatWidget.on('identity-expired', async () => {
  const response = await fetch('/chat-token', { credentials: 'same-origin' });
  if (response.ok) {
    const { userJwt } = await response.json();
    ChatWidget.identify({ jwt: userJwt });
  }
});
```

A page that does not listen has its visitor told once that they are chatting
as a guest.

**The older HMAC scheme still works**: `data-user-id` plus `data-user-hash`,
the hex HMAC-SHA256 of the id with the same secret. It never expires and
carries nothing but the id, which is why the JWT is recommended. A page that
sends both is judged on the token. The REST fallback (`POST /api/chat/message`)
accepts only the HMAC pair.

**Rotating the secret** (same screen) invalidates every token and hash at
once; deploy the new secret to your server straight after.

### 2.5 Email-code verification

Most shops have no login before checkout, so a customer asking "where is my
order?" had no way to prove anything and verified-only actions were simply
unavailable to them. With email codes, the visitor types their address, gets
a six-digit code, and types it back; they are then verified **by email
code**.

A code proves the inbox, not a login, so it unlocks only what you say it may:

1. **Bot → Actions**, open an action that requires a verified customer, and
   tick **Email verification is enough**. Do this for actions where the email
   address is the account key, such as an order lookup by email. Every other
   verified-only action still needs a signed visitor (2.4). Connected tools
   (2.8) marked "verified customers only" always need a signed visitor.
2. That is all. When verifying would unlock something, the assistant is given
   a way to offer it: it shows a **Verify with your email** button, which
   opens the code form in the chat. Your page can also open it with
   `ChatWidget.verifyEmail()` and hear the result through the widget's
   `verified` event.

The code lives 10 minutes and allows 3 wrong guesses. Limits stop abuse: 3
codes per chat per 10 minutes, 5 per email address per hour, and a ceiling
per company per hour (`VERIFY_EMAIL_HOURLY_LIMIT`, 200 by default, set by the
platform operator). The email is in the visitor's language and comes from
your deployment's outbound address under your company's name, so it needs
`EMAIL_HOST` and `EMAIL_FROM` (1.1).

Nothing needs setting up for a verified visitor to be safe from mix-ups: a
typed email never attaches a session to a verified person, and a session
verified by code never joins one verified by your signature.

### 2.6 The WordPress plugin

The plugin puts the chat on every page without editing the theme, and can
sign in logged-in WordPress users for you (2.4) without you writing code. It
is not in the WordPress.org directory yet; you download it from your
dashboard.

1. **In the dashboard**: **Channels → Website widget → WordPress** tab →
   download the plugin. The zip comes with your widget key and server
   address filled in.
2. **In WordPress**: **Plugins → Add New → Upload Plugin**, choose the zip,
   **Install Now**, **Activate**.
3. **Settings → Support Desk Chat**: check the server address (it must be
   `https://`) and the widget key, optionally list pages to hide it on
   (`/checkout`), and **Save**.
4. **In the dashboard**: add your site's address under **Allowed domains**
   on the same Website widget screen. The chat stays silent on sites not
   listed.
5. Optional, to recognise logged-in users: copy the secret from
   **Developers → Identity verification** into **Identity secret**, tick
   **Logged-in users**, **Save**. Or define
   `SUPPORT_DESK_CHAT_IDENTITY_SECRET` in `wp-config.php` to keep it out of
   the database. The plugin signs a one-hour token per page for logged-in
   users (their WordPress user id, email and display name) and fetches a new
   one through `admin-ajax` when it runs out.
6. Clear your caching plugin's cache.

Tokens are added only to pages for logged-in users, which WordPress marks
uncacheable; if a CDN caches pages regardless of login, exclude logged-in
users there or leave **Logged-in users** off. Developers can add signed
attributes with the `support_desk_chat_identity_claims` filter, change the
token lifetime with `support_desk_chat_token_ttl`, and decide per page with
`support_desk_chat_show` (all in the plugin's `readme.txt`). Uninstalling
removes its settings.

### 2.7 Shopify

There is no Shopify app yet; a theme snippet does the same job.

1. **In the dashboard**: add both your `your-shop.myshopify.com` address and
   your own domain under **Allowed domains**.
2. **Channels → Website widget → Shopify** tab: download
   `support-desk-chat.liquid`, filled in with your key and server.
3. **In Shopify**: **Online Store → Themes → … → Edit code**, **Snippets →
   Add a new snippet** named `support-desk-chat`, paste the file, **Save**.
4. In `layout/theme.liquid`, just before `</body>`, add
   `{% render 'support-desk-chat' %}` and **Save**.
5. Open the store: the chat appears, and **Website widget** says "Seen on …"
   within a minute.

A theme change that replaces `theme.liquid` removes the `render` line; add it
again.

Everyone chats as a guest by default. To recognise logged-in customers your
own small server has to sign for them, because Liquid cannot sign anything
and the secret must never be in a theme. Two ways, set with `sdc_identity` at
the top of the snippet; the full walk-through, with a Node example, is in
`sdk/shopify/README.md`:

- **`app_proxy`** (recommended): an App Proxy on an app you own forwards
  `/apps/support-desk/token` to your server, which checks Shopify's
  signature and returns `{"jwt": "..."}` for the logged-in customer. Tokens
  expire within the hour and are fetched again when they do.
- **`metafield`**: your server stores `HMAC-SHA256(identity secret, customer
  id)` in the customer metafield `support_desk.user_hash`. Simpler, but the
  hash never expires.

### 2.8 MCP servers (connected tools)

Many services publish what an assistant may do in them as an MCP server
(Model Context Protocol): Stripe, Shopify, HubSpot, Zapier, Notion and
others. Connect one and switch on the tools your bot may use, one at a time.

1. **Bot → Actions → Connected tools (MCP) → Connect a server.** A name, the
   server's URL (`https://` only), and how it authenticates: none, a bearer
   token, or a custom header such as `X-Api-Key`. The credential is stored
   encrypted and never shown again; it is only ever sent to the server it was
   saved for, so changing the address means typing it again. Up to 10
   servers.
2. **Connect & list tools.** The client speaks both the current stateless
   protocol (2026-07-28) and the older handshake (2025-03-26 to 2025-11-25),
   over Streamable HTTP. Servers that need an OAuth sign-in cannot be
   connected yet; use one that accepts a key or token.
3. Every tool arrives **switched off**. For each one you want:
   - **On**. Each tool switched on counts as one action against your plan's
     actions allowance, together with your saved Actions.
   - **Automatic** (the assistant may use it) or **Workflow only**.
     Workflows cannot call MCP tools yet, so a workflow-only tool is not
     used at all for now.
   - **Verified customers only**: offered only to visitors your site signed
     in (2.4); an email code is not enough here.
   - **Ask before running**: the customer confirms first. On by default for
     every tool the server does not mark read-only, and switched back on if
     a tool stops claiming to be read-only.
4. Try it in **Test your bot**. Tools that may change something never run
   there, whatever the switches say.
5. **Refresh tools** after the server adds or changes tools. A tool whose
   description or schema changed is marked so; one the server no longer
   lists is kept, unavailable, with your settings.

The same guards as saved Actions apply: at most one change per turn, a
15-second limit per call, results capped and fenced as data so the model
does not take them as instructions, and an audit entry for every call
(`mcp.tool_called`, naming the tool and the outcome, never the values).

**Security notes. Read these before switching anything on.**

- **The server's own words steer the assistant.** It reads each tool's
  description to decide when to use it, and that text comes from the server.
  A server you do not trust could describe a tool so that the assistant uses
  it when it should not, or phrase a result to mislead it. Connect only
  servers you run or trust as much as you would trust code in your own
  product.
- **"Verified customers only" limits who can trigger a tool, not whose data
  it reads.** If a tool takes a customer id as an argument, the assistant
  supplies it, and nothing stops it supplying someone else's. For per-customer
  lookups where the id must come from the proof, use a saved Action with an
  input whose source is the verified contact.
- **The credential is your credential.** Whatever the token can do, any tool
  you switch on can be asked to do. Give the server a key scoped to what the
  bot needs (a restricted Stripe key, a read-only token).
- Addresses inside your network are refused, as for every URL a tenant types.

### 2.9 Installing the operator app

The dashboard installs as an app on phones and computers, so an operator can
answer from anywhere and get a notification when a customer needs a person,
even with the app closed. It is the same dashboard: nothing to download from
a store. Push notifications need your deployment's operator to have set up
VAPID keys (1.2); without them the app still installs but cannot notify.

**Android** (Chrome or Edge): open the dashboard and sign in. Use **Install
the app** in the profile menu (or the browser's own install prompt), then
**My settings → Notifications on this device → Turn on notifications** and
allow them. **Send a test** to check.

**iPhone and iPad** (iOS / iPadOS 16.4 or later): notifications only reach an
app on the home screen. In **Safari**, open the dashboard, tap **Share →
Add to Home Screen**, open the app from the home screen, sign in, then **My
settings → Notifications on this device → Turn on notifications**.

**Desktop** (Chrome or Edge on Windows, macOS, Linux): **Install the app**
from the profile menu or the install icon in the address bar. On a computer
where the dashboard is always open you do not need push: it alerts you
itself, and stands down its own alert in a browser where push is on, so you
are not told twice.

What reaches the device: new chats and hand-overs (to operators taking
chats, and not outside business hours), chats assigned or transferred to
you, low ratings, tasks assigned to you, usage warnings, and a repeat alert
when someone has waited too long for a person (**Team → Routing**, default 5
minutes). Per device you choose all of these or **only when I'm needed**,
and whether to show message previews (off by default: a notification then
says who is waiting but not what they wrote).

Each device is listed under **Your devices** and can be removed there.
Signing out of a device, or **Sign out on every device**, stops its
notifications.
