=== Support Desk Chat ===
Contributors: supportdesk
Tags: live chat, chatbot, customer support, ai assistant, help desk
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds your Support Desk chat to every page, and lets the assistant and your team recognise customers who are logged in.

== Description ==

Support Desk Chat puts your Support Desk chat widget on your WordPress site without editing your theme. The assistant answers from your own content, and hands the conversation to your team when a person is needed.

* **No code.** Paste your widget key and server address, and the chat appears on every page.
* **Hide it where it does not belong.** List the pages to leave out, such as `/checkout`.
* **Recognise logged-in customers.** Optionally, the plugin signs a short-lived token for each logged-in user with your identity secret, so your team sees who they are talking to and the assistant can look up their account. The secret stays on your server: it is never printed into pages.
* **Tokens refresh themselves.** Tokens last an hour; when one runs out, the chat asks your site for a new one without a page reload.

The look, the greeting, opening hours and everything else are set in your Support Desk dashboard and reach your site straight away.

= What is sent where =

The chat loads from your Support Desk server. When "Logged-in users" is on, each page shown to a logged-in user carries a token holding their WordPress user ID, email address and display name, signed so the chat server can trust it. Nothing is sent for visitors who are not logged in until they start a chat.

== Installation ==

1. In your Support Desk dashboard, open **Website widget** and choose the **WordPress** tab. Download the plugin there (it comes with your widget key and server address filled in), or install it from **Plugins → Add New**.
2. In WordPress, go to **Plugins → Add New → Upload Plugin**, choose the zip file and click **Install Now**, then **Activate**.
3. Open **Settings → Support Desk Chat**. Check the server address and widget key (both are in the install snippet on **Website widget**), and save.
4. In the dashboard, add your site's address under **Allowed domains** on **Website widget**. The chat does not answer on sites that are not listed.
5. Optional: to recognise logged-in users, copy the secret from **Identity verification** in the dashboard into **Identity secret**, tick **Logged-in users** and save. You can define `SUPPORT_DESK_CHAT_IDENTITY_SECRET` in `wp-config.php` instead, to keep it out of the database.
6. If you use a caching plugin, clear its cache.

== Frequently Asked Questions ==

= The chat does not appear =

Check that **Show the chat on this site** is ticked, that the page is not in **Hide on these pages**, and that your site's address is in **Allowed domains** in the dashboard. Clear any page cache.

= Is the token safe with page caching? =

Tokens are only added to pages for logged-in users, which WordPress marks as not cacheable and caching plugins skip. If a CDN in front of your site caches pages regardless of login, exclude logged-in users there too, or leave **Logged-in users** off.

= Can I add more about the user, such as a customer number? =

Yes. Use the `support_desk_chat_identity_claims` filter and add an `attrs` array of short values; your team sees them as verified:

    add_filter( 'support_desk_chat_identity_claims', function ( $claims, $user ) {
        $claims['attrs'] = array( 'customer_number' => get_user_meta( $user->ID, 'customer_number', true ) );
        return $claims;
    }, 10, 2 );

= Can I change how long a token lasts? =

Use the `support_desk_chat_token_ttl` filter (seconds, at most a day). Shorter is safer; the chat refreshes it on its own.

= Can I show the chat only on some pages? =

Use the `support_desk_chat_show` filter, which receives the plugin's own answer for the current page.

== Changelog ==

= 1.0.0 =
* First release: the chat on every page, page exclusions, and signed identities for logged-in users.
