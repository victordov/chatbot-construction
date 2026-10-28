# Chatbot Widget Integration Guide

This document explains how to add the chat widget to your website.

## Quick start

1. In the dashboard, open **Channels → Website widget** and add your site's
   address under **Allowed domains** (for example `https://www.example.com`).
   The widget answers only on the domains listed there.
2. Copy the snippet from the same page and paste it just before the closing
   `</body>` tag of every page:

```html
<script
  src="https://your-server-url/widget/js/widget-loader.js"
  data-widget-key="your-widget-key"
  data-server-url="https://your-server-url"
  defer></script>
```

The dashboard fills in your server URL and widget key. Everything else - the
assistant's name, colours, greeting, suggested questions, consent and so on -
comes from the dashboard, so a change you save there reaches your site without
editing it.

`data-widget-key` says which company the widget belongs to.
`data-server-url` is optional: when it is missing the loader uses the origin
it was itself loaded from. It never falls back to localhost.

Once a page with the snippet has been opened, the dashboard shows
**Seen on www.example.com** next to the snippet. **Check my site** fetches a
page you name and tells you whether the snippet is on it.

### WordPress

The simplest way is our plugin. On **Channels → Website widget**, open the
**WordPress** tab and download it: the zip comes with your widget key and
server address filled in. In WordPress, **Plugins → Add New → Upload
Plugin**, choose the zip, **Install Now** and **Activate**, then check
**Settings → Support Desk Chat** and save. There you can also list pages to
leave the chat off (`/checkout`, say) and, with the secret from **Identity
verification**, have logged-in WordPress users recognised automatically (see
[Signed-in visitors](#signed-in-visitors)); the plugin signs a short-lived
token for each of them on your server and renews it when it runs out. Clear
your caching plugin's cache afterwards.

Without the plugin: install a header and footer plugin (WPCode, for example),
paste the snippet into its **Footer** box and save, or paste it just before
`</body>` in your theme's `footer.php` (**Appearance → Theme File Editor**); a
theme update can undo that.

### Shopify

On **Channels → Website widget**, open the **Shopify** tab and download
`support-desk-chat.liquid`, filled in with your key and server. In Shopify,
**Online Store → Themes → … → Edit code**, add a snippet named
`support-desk-chat` under **Snippets** and paste the file into it, then in
`layout/theme.liquid`, just before `</body>`, add
`{% render 'support-desk-chat' %}`. Add both your `myshopify.com` address and
your own domain under **Allowed domains**. Everyone chats as a guest until
you set up recognising logged-in customers, which needs a small server of
your own (an App Proxy that returns a token, or a customer metafield holding
a hash); the snippet's comments and the README that comes with it explain
both.

Or paste the plain snippet into `layout/theme.liquid` just before `</body>`.

### Google Tag Manager

Add a **Custom HTML** tag containing the snippet, triggered on **All Pages**,
and publish. Tag Manager adds the snippet after the page loads, so **Check my
site** cannot see it; the **Seen on…** status confirms it instead.

## Allowed domains

The widget answers only on the origins listed under **Allowed domains**. On
any other site it stays silent, even with your key in the page: the key is
public (it is in your page source), so it identifies your company but does not
prove a page is yours. List every origin your site uses - `https://example.com`
and `https://www.example.com` are different origins. `http://localhost` is
accepted only on a server running in development, never in production.

## Configuration options

Attributes on the script tag override the settings saved in the dashboard,
which in turn override the built-in defaults. The dashboard's snippet sets only
the key and the server URL; add the attributes below only where a page needs
something different from the dashboard.

Snippets copied from older versions of the dashboard also set
`data-chatbot-name`, `data-primary-color` and `data-position`. Those keep
overriding the dashboard until you replace the snippet; **Check my site** points
them out.

| Attribute | Description | Default |
|-----------|-------------|---------|
| `data-widget-key` | Identifies your company. Take it from the dashboard. | none (required) |
| `data-server-url` | The URL of your chatbot server | the origin the loader was fetched from |
| `data-chatbot-name` | The name shown in the chat header | the dashboard setting |
| `data-primary-color` | The widget's accent colour (hex) | the dashboard setting |
| `data-position` | `right` or `left` | the dashboard setting |
| `data-initial-message` | The greeting shown to a visitor starting a new conversation | the dashboard setting |
| `data-require-name` | `true`/`false`: ask for the visitor's name before the chat | the dashboard setting (off unless turned on) |
| `data-require-email` | `true`/`false`: ask for the visitor's email before the chat | the dashboard setting (off unless turned on) |
| `data-require-phone` | `true`/`false`: ask for the visitor's phone number before the chat | the dashboard setting (off unless turned on) |
| `data-privacy-policy-url` | Your privacy policy, linked from the pre-chat form and the consent line | the dashboard setting; no link when neither is set |
| `data-language` | `en`, `es`, `fr`, `de`, `it`, `pt`, `ro`, `ru`, `uk`, `pl`, `nl`, or `auto` for the visitor's browser. Wins over the dashboard setting | dashboard setting, else `auto` |
| `data-dir` | `ltr`, `rtl` or `auto`: text direction, for a right-to-left page | follows the language |
| `data-logo-url` | An `https://` image shown in the header | none |
| `data-user-jwt` | A short-lived token your server signs for a logged-in visitor (recommended; see [Signed-in visitors](#signed-in-visitors)) | none |
| `data-user-id` | Your own id for a logged-in visitor, with `data-user-hash` (the older scheme) | none |
| `data-user-hash` | HMAC of `data-user-id`, computed on your server with your identity secret | none |

### Who the visitor is talking to

While the assistant keeps the default name "Assistant", the header shows your
company's name and logo. When a person from your team joins, the header shows
their name with "from <your company>" underneath, and the **Talk to a person**
button goes away until they leave.

The greeting always says the visitor is talking to an AI assistant (EU AI Act,
Article 50). If your own welcome message does not say so, a short line is
added under it in the visitor's language.

### Suggested questions

Up to four questions, set in the dashboard, are shown as buttons under the
greeting. A tap sends the question. They disappear once the conversation
starts.

### The pre-chat form and consent

The pre-chat form is off by default: a form in front of the first answer loses
more conversations than it gains. Turn on name, email or phone in the dashboard
(or with the attributes above) to ask for them first. Accounts created before
October 2026 started with name and email switched on; check the setting if the
form appears and you did not ask for it. Details the visitor
enters are kept in their browser's local storage for 30 days so they are not
asked twice, then discarded.

With **Ask visitors to agree before their first message is stored** switched
on, the widget shows a checkbox with your consent text (or a translated default)
and a link to your privacy policy. Nothing the visitor types or uploads is sent
until they tick it.

You are the data controller for your visitors' conversations, so the widget
links your privacy policy, not ours. With no policy URL set it shows no privacy
link at all, and the dashboard warns you.

### When nobody can answer

The widget never leaves a visitor at a dead end:

- Outside your business hours, or when nobody on your team is online,
  **Talk to a person** becomes **Leave a message** and opens a short form for
  an email address and an optional message. The visitor is told where the
  reply will go.
- When the assistant cannot answer, or a visitor marks an answer as unhelpful,
  the widget offers a person (or the same form).

### Proactive message

A short message can appear above the chat button after a delay (5 to 120
seconds), on every page or only on pages whose address contains some text you
choose (`/pricing`, say). It is shown once per visit, never to someone already
chatting, and goes away for good when dismissed.

### Signed-in visitors

If your visitors log in to your site, tell the widget who they are. The
conversation is then attached to the right person, your team sees them
marked verified, and the assistant may use the actions you marked "requires
a verified customer", with their id taken from your proof rather than from
anything typed.

**Recommended: a signed token.** On your server, for each page you show a
logged-in user, sign a JWT with the identity secret from **Developers →
Identity verification** (HS256) and put it on the snippet:

```html
<script
  src="https://your-server-url/widget/js/widget-loader.js"
  data-widget-key="your-widget-key"
  data-server-url="https://your-server-url"
  data-user-jwt="eyJhbGciOiJIUzI1NiIs…"
  defer></script>
```

The token must carry `sub` (your id for the user) and `exp` (no more than 24
hours ahead; an hour is a good choice), and may carry `aud` (your widget key,
recommended: a token made for anything else is then refused), `iat`, `email`
and `name` (shown to your team as verified), and `attrs`, an object of
details you vouch for, such as a plan or an account number, which your team
sees marked as signed. The **Identity verification** screen has ready-made
examples in Node.js, Python, PHP and Ruby with your widget key filled in.
Never put the secret itself in a page.

A token runs out by design, so a copy lifted from a page soon stops working.
When it does, the visitor carries on as a guest and the widget fires
`identity-expired`. Listen for it, fetch a fresh token from your own server
and pass it to `ChatWidget.identify({ jwt })`; the visitor does not notice
(see [JavaScript API](#javascript-api)). If you do not listen, the visitor is
told once that they are chatting as a guest.

**Older: a hash.** Set `data-user-id` to your own identifier and
`data-user-hash` to the HMAC-SHA256 of that id, as hex, computed on your
server with the same secret. It still works, but it never expires and can
carry nothing but the id. If a page sends both, the token is used.

Whatever you send, ids without a valid signature are ignored, so a visitor
cannot claim to be somebody else by editing the page.

A conversation belongs to the person who started it. When a different user id
arrives on the same browser - a shared computer, say - the widget clears the
stored conversation and starts a new one. A page with no user id after a
signed-in one does the same. When someone signs out, call
`ChatWidget.shutdown()`.

### Verifying an email address in the chat

A visitor who is not logged in can still prove who they are for things like
"where is my order?": they type their email address, receive a six-digit
code, and type it back. The code lasts ten minutes and allows three tries;
the email is in the visitor's language and comes under your company's name.

It unlocks only the actions you marked **Email verification is enough** in
**Bot → Actions**, because a code proves an inbox rather than a login. When
proving an email would unlock one of them, the assistant offers it itself
with a **Verify with your email** button. Your page can also open the form
with `ChatWidget.verifyEmail()`, and hear when it succeeds through the
`verified` event (below).

### Booking appointments

If you connected a calendar under **Bot → Booking**, free times appear in the
chat as buttons and the visitor taps one to book, after confirming. With a
Calendly account on Calendly's free plan the bot cannot book directly, so the
visitor gets a card with a **Finish booking** link instead: it opens
Calendly's page for that appointment with their name, email and chosen day
filled in, and they confirm there. A booking can be cancelled in the chat with
its reference (it looks like `BK-7F3K2Q`).

## JavaScript API

The loader defines `window.ChatWidget` straight away, so you can call it right
after the snippet; calls made before the widget has loaded are run once it
has.

```js
ChatWidget.open();          // open the chat window
ChatWidget.close();         // close it
ChatWidget.toggle();        // open if closed, close if open

// Tell the widget who the visitor is, with a token your server signed
// (recommended; the user id is the token's `sub`). A different user from the
// stored conversation's starts a new conversation for the new person; the
// same user with a fresh token signs them back in.
ChatWidget.identify({ jwt: userJwt });

// Or the older way: userHash is HMAC-SHA256(identitySecret, userId), hex,
// computed on your server.
ChatWidget.identify({
  userId: 'customer-4521',
  userHash: '9f86d0…',
  name: 'Alex Morgan',
  email: 'alex@example.com'
});

// Open the chat on the "verify your email" form.
ChatWidget.verifyEmail();

// Take the widget off the page and forget the conversation, e.g. on sign-out.
// ChatWidget.init() brings it back as a new visitor.
ChatWidget.shutdown();

// Events
function onMessage(message) {
  // { id, sender: 'visitor' | 'bot' | 'operator', text, operatorName? }
}
ChatWidget.on('message', onMessage);
ChatWidget.off('message', onMessage);

ChatWidget.on('open', () => { /* the window opened */ });
ChatWidget.on('close', () => { /* the window closed */ });
ChatWidget.on('handoff', event => {
  // event.status: 'requested' | 'queued' | 'connected' | 'offline' | 'message_left'
  // event.operatorName when a person has joined
});

// The visitor proved their email address with a code in the chat.
ChatWidget.on('verified', event => {
  // { method: 'email', email: 'alex@example.com' }
});

// The token from data-user-jwt or identify({jwt}) has run out. Fetch a fresh
// one from your server and hand it over; the visitor need not notice.
ChatWidget.on('identity-expired', async event => {
  // { userId: 'customer-4521' }
  const response = await fetch('/chat-token', { credentials: 'same-origin' });
  if (response.ok) {
    const { userJwt } = await response.json();
    ChatWidget.identify({ jwt: userJwt });
  }
});
```

`/chat-token` above stands for an endpoint of your own that signs a new token
for whoever is logged in. `window.ChatbotWidget` is the same object, kept for
older pages.

## Content-Security-Policy on your site

If your page sends a `Content-Security-Policy` header, allow the following for
your chatbot server's origin (`https://your-server-url` below):

```
script-src  'self' https://your-server-url;
connect-src 'self' https://your-server-url wss://your-server-url;
img-src     'self' data: https:;
```

- `script-src`: the loader, the widget script and the socket.io client are all
  loaded from the server.
- `connect-src`: the widget fetches its configuration and uploads files over
  HTTPS, and talks over a WebSocket (`wss:`) for the conversation itself.
- `img-src`: only needed if your assistant shows product cards with pictures
  hosted elsewhere.

No `style-src` allowance is needed. The widget renders inside a Shadow DOM
root with its own stylesheet, so it neither needs inline styles on your page
nor is affected by your page's CSS.

## Features

### Real-time chat

The widget talks to the server over a WebSocket. Messages appear as they are
sent, and the visitor is told when the connection drops ("Reconnecting…") -
sending is paused until it is back, so nothing is silently lost. The message
box grows to a few lines: Enter sends, Shift+Enter starts a new line. Links
in answers open in a new tab.

### File uploads

Once the conversation has started, visitors can attach a file with the
paperclip button. Accepted types are PNG, JPEG, GIF and WebP images, PDF,
plain text, CSV, Word (`.doc`, `.docx`) and Excel (`.xls`, `.xlsx`). The limit
is 10 MB per file; larger files are refused in the browser before any upload
starts. On plans without file uploads the paperclip is not shown.

### Session persistence

A conversation survives page refreshes and is shared between tabs of the same
browser, so a visitor can keep talking while moving around your site. Opening
the chat in one tab does not open it in the others. The transcript, with its
sources, product cards and the answer to each question, is restored when the
widget loads.

### Typing indicators and read receipts

The widget shows when the assistant or an operator is typing. A visitor's
message shows one tick when the server has it and two once a person from your
team has read it.

### Rating answers

Answers from the assistant carry small thumbs-up and thumbs-down buttons. A
thumbs-down offers the visitor a person. Your team sees the ratings in the
dashboard.

### Talk to a person

The header carries a "Talk to a person" button once the visitor has said
something. When an operator is available they join the same conversation;
otherwise the visitor is told they are in the queue, or - when nobody can
answer - offered the leave-a-message form. Outside your business hours the
widget stays live but opens with your closed message and the time you reopen.

### Accessibility and mobile

The launcher is a real button with a label, the transcript is announced to
screen readers as new replies arrive, typing is announced, and inputs are
labelled. Closing the chat returns focus to the launcher. On phones the
window fills the screen, keeps keyboard focus inside it, respects the notch
and home-indicator insets, and uses 16px inputs so iOS does not zoom the
page. Animations are disabled for visitors who have asked their system for
reduced motion. Right-to-left text is supported (`data-dir="rtl"`).

## Security

- The widget answers only on the domains listed under **Allowed domains**. The
  widget key identifies your company; on its own it is not enough to chat
  from a site you have not listed.
- Each browser is issued a session token; the token is required to resume the
  conversation, so a session id on its own is not enough to read a
  transcript.
- The widget never overwrites a `window.io` your page already defines; it
  loads the socket.io client only when there is none.

## Browser compatibility

The widget works in current versions of Chrome, Firefox, Safari and Edge.
Internet Explorer is not supported.

## Troubleshooting

### The widget does not appear, or never answers

- Open **Channels → Website widget** and use **Check my site**.
- Confirm the page's exact origin (scheme, `www.` or not, port) is in your
  allowed-domains list.
- Check the browser console for errors.
- Confirm `data-server-url` (if set) is correct and the server is reachable.
- If your site sends a Content-Security-Policy, see the section above.

### My dashboard changes do not show on the site

- Your snippet probably still sets `data-chatbot-name`, `data-primary-color`
  or `data-position`. Replace it with the snippet from the dashboard.

### The widget shows "Offline" or "Reconnecting…"

- The WebSocket connection is being blocked. Check that `wss://` to your
  server is allowed by your CSP and any corporate proxy.
- Confirm the server is running and reachable from the visitor's network.

### File uploads fail

- Files over 10 MB are refused.
- Check the file type is one of those listed under **File uploads**.
- The upload goes to `POST /api/upload` on the server; confirm that endpoint
  is reachable from the page (CORS and CSP `connect-src`).

## Support

Contact the team that runs your chatbot server; their details are in the
dashboard under **Settings**.
