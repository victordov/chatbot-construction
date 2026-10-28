# Support Desk Chat on Shopify

`support-desk-chat.liquid` is a theme snippet that puts the chat widget on
every page of a Shopify store. Out of the box everyone chats as a guest;
recognising logged-in customers is an optional second step that needs a small
server of your own, because Liquid cannot sign anything and the identity
secret must never be in a theme.

## Install the chat

1. **Allow your shop's addresses.** In the dashboard, open **Website widget →
   Allowed domains** and add both your `your-shop.myshopify.com` address and
   your own domain, if you have one. The widget does not answer anywhere else.
2. **Get the snippet.** On **Website widget**, choose the **Shopify** tab and
   download `support-desk-chat.liquid`: it comes with your widget key and
   server address filled in. (Using the copy in this folder instead? Set
   `sdc_server_url` and `sdc_widget_key` at the top to the `data-server-url`
   and `data-widget-key` values from the install snippet.)
3. **Add it to your theme.** In Shopify admin open **Online Store → Themes**,
   then **… → Edit code** on your live theme. Under **Snippets**, choose
   **Add a new snippet**, name it `support-desk-chat`, paste the file's
   contents and **Save**.
4. **Render it on every page.** Open `layout/theme.liquid` and, just before
   `</body>`, add:

   ```liquid
   {% render 'support-desk-chat' %}
   ```

   and **Save**.
5. **Check.** Open your store in a browser. The chat button appears, and the
   status on **Website widget** changes to "Seen on …" within a minute.

Theme updates that replace `layout/theme.liquid` remove the `render` line; add
it again after changing themes.

## Recognise logged-in customers (optional)

A customer who is logged in to your store can be verified, so your team sees
who they are and the assistant can use your verified-only actions (order
status, for example). Your server signs for the customer with the identity
secret from **Identity verification** in the dashboard. Pick one of two ways
and set `sdc_identity` at the top of the snippet.

### Option A: an App Proxy that returns a token (recommended)

Tokens expire within the hour, so one copied from a page is soon worthless,
and they can carry details such as a customer tag.

1. In an app you own (built with Shopify CLI, or created in the Partner
   Dashboard), add an **App proxy**: prefix `apps`, subpath `support-desk`,
   proxy URL pointing at your server, e.g.
   `https://your-server.example.com/shopify/chat-token`. Shopify then forwards
   `https://your-shop.com/apps/support-desk/token` to that URL, adding
   `logged_in_customer_id` and a `signature`.
2. On your server, check Shopify's signature, then sign a token for the
   customer. Node example:

   ```js
   const crypto = require('crypto');
   const jwt = require('jsonwebtoken');

   app.get('/shopify/chat-token', (req, res) => {
     const { signature = '', ...params } = req.query;
     // Shopify signs the other parameters, sorted, as key=value with nothing
     // between them; repeated values are joined with commas.
     const message = Object.keys(params).sort()
       .map(key => `${key}=${[].concat(params[key]).join(',')}`)
       .join('');
     const expected = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
       .update(message).digest('hex');
     if (signature.length !== expected.length ||
         !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
       return res.status(401).end();
     }

     const customerId = params.logged_in_customer_id;
     if (!customerId) {
       return res.status(204).end(); // a guest: nothing to sign
     }

     const token = jwt.sign(
       { sub: String(customerId), aud: process.env.CHAT_WIDGET_KEY },
       process.env.CHAT_IDENTITY_SECRET,
       { algorithm: 'HS256', expiresIn: '1h' }
     );
     res.set('Cache-Control', 'no-store').json({ jwt: token });
   });
   ```

   Add `email`, `name` or `attrs` to the payload if your server looks the
   customer up through the Admin API; they are shown to your team as verified.
3. In the snippet set `sdc_identity` to `'app_proxy'`. If you chose a
   different subpath, set `sdc_token_path` to match.

### Option B: a customer metafield holding a hash

No proxy needed, but the hash never expires and carries nothing but the id.

1. Whenever a customer is created (the `customers/create` webhook) and once
   for existing customers, have your server compute
   `HMAC-SHA256(identity secret, customer id)` as hex and store it through the
   Admin API in the customer metafield `support_desk.user_hash`
   (single line text).
2. In the snippet set `sdc_identity` to `'metafield'`.

## Questions

- **Can a customer see their token or hash?** Yes, in their own page's source.
  It proves who they are and nothing more; it is no use to anyone else (and a
  token stops working within the hour).
- **Will the store's page cache leak one customer's token to another?** The
  token is fetched by the browser after the page loads (Option A) and is never
  in the cached HTML. Liquid output for a logged-in customer (Option B) is not
  shared between customers.
- **Can I hide the chat on some pages?** Wrap the `render` line in a Liquid
  condition, e.g. `{% unless template contains 'cart' %}…{% endunless %}`.
