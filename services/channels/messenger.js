/**
 * Facebook Messenger and Instagram Direct, through the Messenger Platform.
 *
 * One adapter for both because they are one API: an Instagram professional
 * account is reached through the Facebook Page it is linked to, with that
 * Page's token, on the same Send API and the same webhook shape. What differs
 * is the webhook's `object` (`page` or `instagram`), which id names the
 * account, and how long a message may be.
 *
 * Messenger: https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
 * Instagram: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message
 */

const graph = require('./graph');
const { chunkText, clip, characters, bytes } = require('./text');

/** Meta's limits. Instagram counts bytes, not characters. */
const LIMITS = {
  messenger: { text: 2000, measure: characters },
  instagram: { text: 1000, measure: bytes },
  quickReplies: 13,
  quickReplyTitle: 20,
  quickReplyPayload: 1000
};

/** The provider a webhook's `object` belongs to. */
const PROVIDER_BY_OBJECT = { page: 'messenger', instagram: 'instagram' };

/** A webhook's account ids: the Page id, or the Instagram account id. */
function accountKeys(payload) {
  const provider = payload && PROVIDER_BY_OBJECT[payload.object];
  if (!provider) {
    return [];
  }
  const keys = new Set((payload.entry || []).map(entry => entry && entry.id).filter(Boolean).map(String));
  return [...keys].map(key => ({ provider, key }));
}

/** What an attachment is, as the inbox stores it. */
function mediaOf(attachment) {
  const payload = attachment.payload || {};
  const kind = { image: 'image', file: 'document', video: 'video', audio: 'audio' }[attachment.type];
  if (kind && payload.url) {
    return { kind, url: payload.url };
  }
  return null;
}

/** A line for something that is not text or a file: a shared post, a story. */
function describeAttachment(attachment) {
  const payload = attachment.payload || {};
  const link = payload.url ? ` ${payload.url}` : '';
  switch (attachment.type) {
  case 'story_mention':
    return `[Mentioned you in their story]${link}`;
  case 'share':
  case 'ig_reel':
  case 'reel':
    return `[Shared a post]${link}`;
  case 'location':
    return `[Location]${link}`;
  default:
    return `[${attachment.type || 'Attachment'}]${link}`;
  }
}

/**
 * Everything a webhook says, as plain events (see services/channels/whatsapp.js
 * for the shape). Echoes of what the Page itself sent are skipped: they are
 * our own replies, or a person answering from Meta's inbox, and either way
 * not the customer.
 */
function parse(payload) {
  const events = [];
  const provider = payload && PROVIDER_BY_OBJECT[payload.object];
  if (!provider) {
    return events;
  }

  (payload.entry || []).forEach(entry => {
    const key = entry && entry.id ? String(entry.id) : null;
    if (!key) {
      return;
    }

    (entry.messaging || []).forEach(event => {
      const userId = event && event.sender && event.sender.id ? String(event.sender.id) : null;
      if (!userId || userId === key) {
        return;
      }
      const timestamp = Number(event.timestamp) > 0 ? new Date(Number(event.timestamp)) : new Date();
      const base = { kind: 'message', provider, key, userId, timestamp };

      if (event.message) {
        const message = event.message;
        if (message.is_echo || message.is_deleted || !message.mid) {
          return;
        }

        if (message.quick_reply && message.quick_reply.payload) {
          events.push({ ...base, messageId: String(message.mid), text: message.text, choice: message.quick_reply.payload });
          return;
        }

        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const files = attachments.map(mediaOf).filter(Boolean);
        const others = attachments.filter(attachment => !mediaOf(attachment)).map(describeAttachment);

        if (files.length > 0) {
          // One event per file, so each lands as its own message with its
          // own download; the text goes with the first.
          files.forEach((media, index) => {
            events.push({
              ...base,
              messageId: index === 0 ? String(message.mid) : `${message.mid}#${index}`,
              text: index === 0 ? [message.text, ...others].filter(Boolean).join('\n') : '',
              media
            });
          });
          return;
        }

        if (message.text) {
          events.push({ ...base, messageId: String(message.mid), text: [message.text, ...others].join('\n').trim() });
        } else if (others.length) {
          events.push({ ...base, messageId: String(message.mid), text: others.join('\n'), note: true });
        } else if (message.is_unsupported) {
          events.push({ ...base, messageId: String(message.mid), text: '[A message this inbox cannot show. Open the app to see it.]', note: true });
        }
        return;
      }

      if (event.postback) {
        // A button tapped on a template, "Get started", or the persistent menu.
        const postback = event.postback;
        events.push({
          ...base,
          messageId: String(postback.mid || `postback-${userId}-${event.timestamp}`),
          text: postback.title || postback.payload,
          choice: postback.payload
        });
      }
    });
  });

  return events;
}

/**
 * Send a reply, as several messages if it is long; quick replies ride on the
 * last.
 *
 * @param {object} account the ChannelAccount (provider messenger or instagram)
 * @param {{token: string, appSecret: string}} credentials
 * @param {string} to the Page- or Instagram-scoped id
 * @param {{text: string, choices?: Array<{id: string, label: string}>}} reply
 * @param {{tag?: string}} [options] `HUMAN_AGENT` to answer after 24 hours
 * @returns {Promise<{ids: string[]}>}
 */
async function send(account, credentials, to, { text, choices = [] }, { tag } = {}) {
  const limits = LIMITS[account.provider] || LIMITS.messenger;
  const parts = chunkText(text, limits.text, limits.measure);
  const quickReplies = choices
    .filter(choice => choice && choice.label)
    .slice(0, LIMITS.quickReplies)
    .map(choice => ({
      content_type: 'text',
      title: clip(choice.label, LIMITS.quickReplyTitle),
      payload: clip(choice.id, LIMITS.quickReplyPayload, '')
    }));

  const ids = [];
  for (let index = 0; index < parts.length; index += 1) {
    const last = index === parts.length - 1;
    const result = await graph.call(`${account.pageId}/messages`, {
      method: 'POST',
      token: credentials.token,
      appSecret: credentials.appSecret,
      body: {
        recipient: { id: to },
        messaging_type: tag ? 'MESSAGE_TAG' : 'RESPONSE',
        ...(tag ? { tag } : {}),
        message: {
          text: parts[index],
          ...(last && quickReplies.length ? { quick_replies: quickReplies } : {})
        }
      }
    });
    ids.push(result && result.message_id ? result.message_id : null);
  }
  return { ids };
}

/** "Seen" under the customer's message, on Messenger. */
async function markRead(account, credentials, messageId, to) {
  if (account.provider !== 'messenger' || !to) {
    return;
  }
  await graph.call(`${account.pageId}/messages`, {
    method: 'POST',
    token: credentials.token,
    appSecret: credentials.appSecret,
    body: { recipient: { id: to }, sender_action: 'mark_seen' }
  });
}

/**
 * Fetch a file a customer sent. The webhook's URL is already signed and
 * expires, so it is fetched now, without the token.
 */
async function fetchMedia(account, credentials, media, { maxBytes, timeoutMs }) {
  return graph.download(media.url, { maxBytes, timeoutMs });
}

function keyOf(account) {
  return account.provider === 'instagram' ? account.igUserId : account.pageId;
}

module.exports = {
  LIMITS,
  accountKeys,
  parse,
  send,
  markRead,
  fetchMedia,
  keyOf
};
