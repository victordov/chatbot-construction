/**
 * WhatsApp, through Meta's Cloud API.
 *
 * Reads what a webhook says into the shape services/channels/inbound.js works
 * with, and turns a reply into the messages WhatsApp accepts: plain text, up
 * to three reply buttons, or a list of up to ten rows - each with its own
 * length limits, which are Meta's and are refused rather than truncated if
 * exceeded, so they are enforced here.
 *
 * Webhooks: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
 * Sending:  https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
 */

const graph = require('./graph');
const { chunkText, clip } = require('./text');

const PROVIDER = 'whatsapp';

/** Meta's limits, from the message reference. */
const LIMITS = {
  text: 4096,
  buttonBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  buttonId: 256,
  listBody: 4096,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  listButton: 20
};

/** What a list's button says. Meta requires one, of 20 characters or fewer. */
const LIST_BUTTON = 'Options';

/** A webhook's account ids, so the caller can find whose secret signs it. */
function accountKeys(payload) {
  const keys = new Set();
  if (!payload || payload.object !== 'whatsapp_business_account') {
    return [];
  }
  (payload.entry || []).forEach(entry => {
    (entry.changes || []).forEach(change => {
      const id = change && change.value && change.value.metadata && change.value.metadata.phone_number_id;
      if (id) {
        keys.add(String(id));
      }
    });
  });
  return [...keys].map(key => ({ provider: PROVIDER, key }));
}

/** A coordinate pair as somebody can open it. */
function mapLink(latitude, longitude) {
  return `https://maps.google.com/?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

/**
 * What one message says, by type.
 *
 * `text` is what the bot answers and the transcript shows; `choice` is the id
 * of a button the customer tapped; `media` a file to fetch; `note` marks a
 * message that is stored for the team but not one the bot can answer (a
 * location, a voice note).
 */
function contentOf(message) {
  const type = message.type;

  switch (type) {
  case 'text':
    return { text: message.text && message.text.body };

  case 'interactive': {
    const interactive = message.interactive || {};
    const reply = interactive.button_reply || interactive.list_reply;
    if (reply) {
      return { text: reply.title, choice: reply.id };
    }
    return { text: '[A form was submitted]', note: true };
  }

  case 'button':
    // A quick-reply button on a template.
    return { text: message.button && (message.button.text || message.button.payload) };

  case 'image':
  case 'document':
  case 'video':
  case 'audio':
  case 'sticker': {
    const media = message[type] || {};
    return {
      text: media.caption || '',
      media: {
        kind: type,
        id: media.id,
        mimeType: media.mime_type,
        fileName: media.filename
      }
    };
  }

  case 'location': {
    const place = message.location || {};
    const named = [place.name, place.address].filter(Boolean).join(', ');
    return {
      text: `[Location${named ? `: ${named}` : ''}] ${mapLink(place.latitude, place.longitude)}`,
      note: true
    };
  }

  case 'contacts': {
    const cards = (message.contacts || []).map(card => {
      const name = card.name && (card.name.formatted_name || card.name.first_name);
      const phones = (card.phones || []).map(phone => phone.phone).filter(Boolean).join(', ');
      return [name, phones].filter(Boolean).join(' ');
    });
    return { text: `[Contact card] ${cards.join('; ')}`.trim(), note: true };
  }

  case 'reaction':
    // A thumbs-up on one of our messages is not something to answer.
    return { ignore: true };

  default:
    return { text: '[A message this inbox cannot show. Open WhatsApp to see it.]', note: true };
  }
}

/**
 * Everything a webhook says, as plain events.
 *
 * @returns {Array<object>} `{kind: 'message', provider, key, userId,
 *          messageId, timestamp, profileName, text, choice?, media?, note?}`
 *          and `{kind: 'status', provider, key, userId, messageId, status,
 *          error?}`
 */
function parse(payload) {
  const events = [];
  if (!payload || payload.object !== 'whatsapp_business_account') {
    return events;
  }

  (payload.entry || []).forEach(entry => {
    (entry.changes || []).forEach(change => {
      if (!change || change.field !== 'messages' || !change.value) {
        return;
      }
      const value = change.value;
      const key = value.metadata && value.metadata.phone_number_id ? String(value.metadata.phone_number_id) : null;
      if (!key) {
        return;
      }

      const names = {};
      (value.contacts || []).forEach(contact => {
        if (contact && contact.wa_id) {
          names[contact.wa_id] = contact.profile && contact.profile.name;
        }
      });

      (value.messages || []).forEach(message => {
        if (!message || !message.id || !message.from) {
          return;
        }
        const content = contentOf(message);
        if (content.ignore) {
          return;
        }
        const seconds = Number(message.timestamp);
        events.push({
          kind: 'message',
          provider: PROVIDER,
          key,
          userId: String(message.from),
          messageId: String(message.id),
          timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
          profileName: names[message.from] || undefined,
          // The number to show an operator; the id is the number on WhatsApp.
          phone: `+${String(message.from).replace(/^\+/, '')}`,
          ...content
        });
      });

      (value.statuses || []).forEach(status => {
        if (!status || !status.id) {
          return;
        }
        const error = Array.isArray(status.errors) && status.errors[0];
        events.push({
          kind: 'status',
          provider: PROVIDER,
          key,
          userId: status.recipient_id ? String(status.recipient_id) : null,
          messageId: String(status.id),
          status: status.status,
          error: error
            ? {
              code: error.code,
              message: (error.error_data && error.error_data.details) || error.message || error.title
            }
            : undefined
        });
      });
    });
  });

  return events;
}

/** One POST to the number's `/messages` edge; resolves to the message id. */
async function post(account, credentials, body) {
  const result = await graph.call(`${account.phoneNumberId}/messages`, {
    method: 'POST',
    token: credentials.token,
    appSecret: credentials.appSecret,
    body: { messaging_product: 'whatsapp', ...body }
  });
  return result && Array.isArray(result.messages) && result.messages[0] ? result.messages[0].id : null;
}

function textMessage(to, body) {
  return { recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
}

/**
 * Up to three choices whose labels fit on a button go as buttons; otherwise a
 * list, which holds ten and longer labels.
 */
function interactiveMessage(to, body, choices) {
  const asButtons = choices.length <= LIMITS.buttons &&
    choices.every(choice => choice.label.length <= LIMITS.buttonTitle);

  if (asButtons) {
    return {
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: choices.map(choice => ({
            type: 'reply',
            reply: { id: clip(choice.id, LIMITS.buttonId, ''), title: choice.label }
          }))
        }
      }
    };
  }

  return {
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: {
        button: LIST_BUTTON,
        sections: [{
          rows: choices.slice(0, LIMITS.listRows).map(choice => ({
            id: clip(choice.id, LIMITS.rowId, ''),
            title: clip(choice.label, LIMITS.rowTitle),
            // A label too long for a row title is shown whole underneath.
            ...(choice.label.length > LIMITS.rowTitle
              ? { description: clip(choice.label, LIMITS.rowDescription) }
              : {})
          }))
        }]
      }
    }
  };
}

/**
 * Send a reply.
 *
 * @param {object} account the ChannelAccount
 * @param {{token: string, appSecret: string}} credentials decrypted
 * @param {string} to the customer's WhatsApp id
 * @param {{text: string, choices?: Array<{id: string, label: string}>}} reply
 * @returns {Promise<{ids: string[]}>}
 * @throws {graph.GraphError}
 */
async function send(account, credentials, to, { text, choices = [] }) {
  const ids = [];
  const usable = choices.filter(choice => choice && choice.label);

  if (usable.length === 0) {
    for (const part of chunkText(text, LIMITS.text)) {
      ids.push(await post(account, credentials, textMessage(to, part)));
    }
    return { ids };
  }

  // The choices ride on the last part of the text, which has to fit an
  // interactive message's body; anything before it goes as plain text first.
  const parts = chunkText(text, LIMITS.text);
  let body = parts.pop() || '…';
  if (body.length > LIMITS.buttonBody) {
    const tail = chunkText(body, LIMITS.buttonBody);
    body = tail.pop();
    parts.push(...tail);
  }

  for (const part of parts) {
    ids.push(await post(account, credentials, textMessage(to, part)));
  }
  ids.push(await post(account, credentials, interactiveMessage(to, body, usable)));
  return { ids };
}

/**
 * Send an approved template: the only thing WhatsApp allows once 24 hours
 * have passed since the customer last wrote.
 *
 * @param {{name: string, language?: string, param?: string, paramName?: string}} template
 * @param {string} value the customer's name, for the template's one parameter
 */
async function sendTemplate(account, credentials, to, template, value) {
  const parameter = { type: 'text', text: value };
  if (template.param === 'named' && template.paramName) {
    parameter.parameter_name = template.paramName;
  }

  const id = await post(account, credentials, {
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language || 'en_US' },
      ...(template.param === 'none' ? {} : { components: [{ type: 'body', parameters: [parameter] }] })
    }
  });
  return { ids: [id] };
}

/** Blue ticks on the customer's message: somebody has read it. */
async function markRead(account, credentials, messageId) {
  await graph.call(`${account.phoneNumberId}/messages`, {
    method: 'POST',
    token: credentials.token,
    appSecret: credentials.appSecret,
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId }
  });
}

/**
 * Fetch a file a customer sent. The webhook carries only an id; the URL it
 * resolves to lasts five minutes and needs the token.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string|null, size: number}>}
 */
async function fetchMedia(account, credentials, media, { maxBytes, timeoutMs }) {
  const info = await graph.call(encodeURIComponent(media.id), {
    token: credentials.token,
    appSecret: credentials.appSecret,
    timeoutMs
  });

  if (info.file_size && Number(info.file_size) > maxBytes) {
    const error = new Error('the file is larger than this inbox accepts');
    error.tooLarge = true;
    throw error;
  }
  if (!info.url) {
    throw new Error('Meta did not say where the file is');
  }

  const file = await graph.download(info.url, { token: credentials.token, maxBytes, timeoutMs });
  return { ...file, mimeType: info.mime_type || file.mimeType };
}

/** The account's id as the settings screen and webhooks name it. */
function keyOf(account) {
  return account.phoneNumberId;
}

module.exports = {
  PROVIDER,
  LIMITS,
  accountKeys,
  parse,
  send,
  sendTemplate,
  markRead,
  fetchMedia,
  keyOf,
  // Exported for tests.
  contentOf,
  interactiveMessage
};
