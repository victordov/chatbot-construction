# Connector SDK

Let your chatbot use your own data. Implement a few methods, expose them at one
URL, and the bot can search your catalogue, show a product with its picture,
offer real appointment times and book one.

You write the part only you can know — how to get a product out of your
database. Everything else (proving the request came from us, checking the
shapes, answering discovery) is handled here.

## Install

```bash
npm install @chatbot-platform/connector-sdk
```

## Implement what applies to you

Anything you leave out is simply not offered. A shop with no appointments
implements the two catalogue methods and nothing else.

```js
const express = require('express');
const { createConnector } = require('@chatbot-platform/connector-sdk');

const app = express();

app.all('/chatbot-connector', createConnector({
  async searchCatalog({ query, limit = 5 }) {
    const rows = await db.products.search(query, limit);

    return rows.map(row => ({
      id: row.sku,
      title: row.name,
      price: `£${row.price.toFixed(2)}`,   // formatted the way you want it read
      image: row.imageUrl,                  // absolute https, no login needed
      url: `https://shop.example/p/${row.slug}`,
      inStock: row.stock > 0
    }));
  },

  async getProduct({ id }) {
    const row = await db.products.bySku(id);
    return { id: row.sku, title: row.name, price: `£${row.price.toFixed(2)}` };
  },

  async listSlots({ from, to }) {
    const slots = await diary.free(from, to);
    return slots.map(s => ({ id: s.id, startsAt: s.start, staff: s.practitioner }));
  },

  async bookSlot({ slotId, name, email, phone }) {
    const booking = await diary.reserve(slotId, { name, email, phone });
    return { id: booking.id, startsAt: booking.start, reference: booking.ref };
  },

  // Optional. Called only after the platform has checked the visitor is in
  // the conversation the booking was made from, or gave the email it was
  // booked under.
  async cancelBooking({ reference, email }) {
    const booking = await diary.cancel(reference);
    return { id: booking.id, startsAt: booking.start, reference: booking.ref, status: 'cancelled' };
  }
}));
```

Then paste `https://yourdomain.example/chatbot-connector` into
**Developers → Your systems** in the dashboard, copy the secret it gives you, and
press **Check**.

## Mount it before your JSON parser

The signature is checked against the exact bytes we sent, so the handler needs
the raw body. If `express.json()` runs first, the original bytes are gone.

```js
app.all('/chatbot-connector', connector);   // before express.json()
app.use(express.json());
```

If that is awkward, use `express.raw({ type: '*/*' })` on this route only. The
SDK will tell you which of these you have hit rather than failing as a bad
signature.

## The secret

```bash
CHATBOT_CONNECTOR_SECRET=csec_...
```

Without it the connector refuses every request. That is deliberate: the URL is
public, and an unprotected connector serves your product data, your diary and
your customers' bookings to anyone who finds it.

Every request from us carries `X-Connector-Signature: t=<unix>,v1=<hex>`, an
HMAC-SHA256 of `<t>.<raw body>`. The SDK verifies it in constant time and
rejects anything more than five minutes old, so a captured request stops working
rather than working forever.

## The shapes

Only the fields below are used. Anything else you return is dropped, so you can
hand us your own objects without stripping them first.

| Product | | |
|---|---|---|
| `id` | required | your own identifier |
| `title` | required | |
| `price` | optional | text, e.g. `"£24.99"` — currency and rounding are yours to decide |
| `image` | optional | absolute https URL |
| `url` | optional | where to buy it |
| `description` | optional | |
| `inStock` | optional | |

| Slot | | |
|---|---|---|
| `id` | required | passed back to `bookSlot` |
| `startsAt` | required | `Date` or ISO string |
| `endsAt` | optional | |
| `label` | optional | shown on the button instead of the time |
| `staff` | optional | |

| Booking | | |
|---|---|---|
| `id` | required | |
| `startsAt` | required | |
| `reference` | optional | what the customer should quote |
| `status` | optional | |

Numbers where we expect text, and `Date` objects where we expect dates, are
converted for you.

## What we do with it

- **Reads** (`searchCatalog`, `getProduct`, `listSlots`) may be called whenever
  a conversation needs them, and are cached for a few seconds so a retry does
  not hit you twice.
- **Writes** (`bookSlot`, `cancelBooking`) are only ever called when a real conversation reaches
  that step. They are never run when somebody is trying a workflow out in the
  editor — testing a branch six times must not put six appointments in your
  diary.

## Errors

Throw. Your message is shown to your own admins in the dashboard, because you
wrote the code and a status code tells them nothing.

```js
async getProduct({ id }) {
  const row = await db.products.bySku(id);
  if (!row) throw new Error(`No product with sku ${id}`);
  return toProduct(row);
}
```

## Checking it works

`GET` your connector URL in a browser. You should see:

```json
{
  "protocol": "chatbot-platform/connector",
  "version": "0.1.0",
  "capabilities": ["catalog.search", "catalog.get"],
  "signed": true
}
```

`signed: false` means `CHATBOT_CONNECTOR_SECRET` is not set and the connector is
open to anyone.
