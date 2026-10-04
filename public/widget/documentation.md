# Chatbot Widget Integration Guide

This document explains how to add the chat widget to your website.

## Quick start

Paste this just before the closing `</body>` tag of your page. The widget key
and server URL are shown in the dashboard under **Install Widget**, with the
values already filled in for your company.

```html
<script
    src="https://your-server-url/widget/js/widget-loader.js"
    data-widget-key="your-widget-key"
    data-server-url="https://your-server-url"
    data-chatbot-name="Your Assistant Name"
    data-primary-color="#2196f3"
    data-position="right"
    defer>
</script>
```

Replace `https://your-server-url` with the URL of your chatbot server, and
`your-widget-key` with the key from the dashboard.

`data-widget-key` is what tells the server which company a conversation belongs
to. Without it, chats are only attributed to you if the page's domain happens
to be registered in your allowed-domains list.

`data-server-url` is optional: when it is missing the loader uses the origin
it was itself loaded from. It never falls back to localhost.

## Configuration options

Attributes on the script tag override the settings saved in the dashboard,
which in turn override the built-in defaults.

| Attribute | Description | Default |
|-----------|-------------|---------|
| `data-widget-key` | Identifies your company. Take it from the dashboard. | none (recommended) |
| `data-server-url` | The URL of your chatbot server | the origin the loader was fetched from |
| `data-chatbot-name` | The name shown in the chat header | "Assistant" |
| `data-primary-color` | The widget's accent colour (hex) | "#2196f3" |
| `data-position` | `right` or `left` | "right" |
| `data-initial-message` | The greeting shown to a visitor starting a new conversation | "Hello! How can I assist you today?" |
| `data-require-name` | `true`/`false`: ask for the visitor's name before the chat | `true` |
| `data-require-email` | `true`/`false`: ask for the visitor's email before the chat | `true` |
| `data-require-phone` | `true`/`false`: ask for the visitor's phone number before the chat | `false` |
| `data-privacy-policy-url` | The privacy policy linked from the pre-chat form | `<server-url>/privacy-policy.html` |
| `data-user-id` | Your own id for a logged-in visitor | none |
| `data-user-hash` | HMAC of `data-user-id`, computed on your server with your identity secret | none |

### The pre-chat form

Before the first message, the widget asks for the visitor's details. Fields
marked required must be filled in; the others are shown as optional. If none
of the three is required the form is skipped and the visitor goes straight to
the chat. The same three settings can be saved in the dashboard under
**Install Widget → Appearance**, so they apply everywhere without editing the
snippet.

Details the visitor enters are kept in their browser's local storage for 30
days so they are not asked twice, then discarded.

### Signed-in visitors

If your visitors log in to your site, you can tell the widget who they are so
the conversation is attached to the right contact. Set `data-user-id` to your
own identifier and `data-user-hash` to the HMAC-SHA256 of that id, computed on
your server with the identity secret from the dashboard. Ids without a valid
hash are ignored, so a visitor cannot claim to be somebody else by editing the
page.

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
sending is paused until it is back, so nothing is silently lost.

### File uploads

Visitors can attach a file with the paperclip button. Accepted types are PNG,
JPEG, GIF and WebP images, PDF, plain text, CSV, Word (`.doc`, `.docx`) and
Excel (`.xls`, `.xlsx`). The limit is 10 MB per file; larger files are refused
in the browser before any upload starts.

### Session persistence

A conversation survives page refreshes and is shared between tabs of the same
browser, so a visitor can keep talking while moving around your site. The
transcript is restored from the server when the widget loads.

### Typing indicators and read receipts

The widget shows when the assistant or an operator is typing, and marks the
visitor's messages as read once they have been seen.

### Talk to a person

The header carries a "Talk to a person" button. When an operator is available
they join the same conversation; otherwise the visitor is told they are in the
queue. Outside your business hours the widget stays live but opens with your
closed message and the time you reopen.

### Accessibility and mobile

The launcher is a real button with a label, the transcript is announced to
screen readers as new replies arrive, and inputs are labelled. On phones the
window fills the screen, respects the notch and home-indicator insets, and
uses 16px inputs so iOS does not zoom the page. Animations are disabled for
visitors who have asked their system for reduced motion.

## Customisation

The accent colour (`data-primary-color`) and position (`data-position`) can be
set on the tag or in the dashboard. Because the widget lives in a Shadow DOM
root, your page's stylesheet does not affect it and its stylesheet does not
affect your page.

## Security

- Conversations are only accepted from domains you have registered, or from
  pages carrying a valid widget key.
- Each browser is issued a session token on its first connection; the token is
  required to resume the conversation, so a session id on its own is not
  enough to read a transcript.
- The widget never overwrites a `window.io` your page already defines; it
  loads the socket.io client only when there is none.

## Browser compatibility

The widget works in current versions of Chrome, Firefox, Safari and Edge.
Internet Explorer is not supported.

## Troubleshooting

### The widget does not appear

- Check the browser console for errors.
- Confirm `data-server-url` (if set) is correct and the server is reachable.
- Confirm the page's domain is in your allowed-domains list, or that
  `data-widget-key` is set.
- If your site sends a Content-Security-Policy, see the section above.

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
