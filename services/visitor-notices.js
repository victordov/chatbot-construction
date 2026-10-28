/**
 * What the server says to a visitor when it is not answering their question.
 *
 * Every one of these lines used to be an English sentence written inline at
 * the place that sent it, so a visitor reading the widget in German got German
 * buttons and English news about their own conversation. Each line now travels
 * as a code the widget translates, with its parameters, and with the English
 * sentence as a fallback for a widget that does not know the code yet.
 *
 * The codes are a contract with the widget (public/widget): add one here and
 * it shows in English until the widget learns to translate it; rename one and
 * every installed widget falls back to English.
 */

const MESSAGES = {
  // The tenant cannot take another conversation: lapsed plan or a spent
  // allowance. Deliberately silent about why - that is between the platform
  // and the tenant, not something to put in front of their customer.
  unavailable: () => 'Sorry, this chat is unavailable right now. Please try again later.',
  // The bot could not produce a reply and the conversation is being passed on.
  // "Test your bot" shows this same sentence (routes/bot.js reads it here).
  reply_failed: () => 'Sorry, I can\'t answer that right now. I\'m passing you to a member of the team.',
  operator_joined: ({ operatorName }) =>
    `${operatorName || 'Someone from the team'} has joined the conversation.`,
  operator_left: ({ operatorName }) =>
    `${operatorName || 'The operator'} has left the conversation. Someone else from the team will pick it up; in the meantime the assistant can help.`,
  handed_back: ({ operatorName }) =>
    `${operatorName || 'The operator'} has handed you back to the assistant.`,
  queued: () => 'Thanks. Someone from the team will be with you shortly; in the meantime the assistant can help.',
  queued_offline: () => 'Nobody from the team is available right now. Leave your email address and we will reply there.',
  followup_saved: ({ email }) => `Thanks. We will reply to ${email || 'you'} by email.`,
  chat_ended: () => 'This conversation has been ended.',
  // The label on the button offered under an answer the bot did not have.
  handoff_offer: () => 'Talk to a person',

  // Identity (services/visitor-identity.js). The page's sign-in token ran
  // out, so the visitor is chatting as a guest until the page sends a fresh
  // one - which it can do on the widget's `identity-expired` event.
  identity_expired: () => 'Your sign-in has expired, so you are chatting as a guest. Reload the page to sign in again.',

  // Verifying an email address with a code (services/visitor-verification.js).
  // The label on the button that starts it.
  verify_email_offer: () => 'Verify with your email',
  verify_email_sent: ({ email }) =>
    `We sent a 6-digit code to ${email || 'your email address'}. It expires in 10 minutes.`,
  verify_email_verified: ({ email }) => `Thanks, ${email || 'your email address'} is verified.`,
  verify_email_invalid: () => 'Please enter a valid email address.',
  verify_email_rate_limited: () => 'Too many codes have been requested. Please wait a few minutes and try again.',
  verify_email_send_failed: () => 'We could not send the code just now. Please try again later.',
  verify_email_unavailable: () => 'Email verification is not available right now.',
  verify_email_wrong_code: () => 'That code is not right. Please check it and try again.',
  verify_email_invalid_code: () => 'Please enter the 6-digit code from the email.',
  verify_email_expired: () => 'That code has expired. Please ask for a new one.',
  verify_email_no_code: () => 'There is no code waiting to be used. Please ask for a new one.',
  verify_email_too_many_attempts: () => 'Too many wrong codes. Please ask for a new one.'
};

const CODES = Object.keys(MESSAGES);

/**
 * A notice, in the shape every visitor-facing payload carries it.
 *
 * Spread into the event's own payload (`{...notice('queued'), queued: true}`)
 * so an existing field such as `text` keeps working for an older widget.
 *
 * @param {string} code one of CODES
 * @param {object} [params] values the sentence names, e.g. `{operatorName}`
 * @returns {{code: string, params: object, message: string}}
 */
function notice(code, params = {}) {
  const render = MESSAGES[code];
  if (!render) {
    throw new Error(`Unknown visitor notice "${code}"`);
  }

  // Only plain values travel: the widget interpolates them into its own
  // translation, and anything else would be rendered as "[object Object]".
  const clean = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && typeof value !== 'object') {
      clean[key] = String(value);
    }
  });

  return { code, params: clean, message: render(clean) };
}

/** The value of the "Talk to a person" quick reply, should it come back as text. */
const HANDOFF_VALUE = '__handoff__';

/**
 * The "Talk to a person" quick reply offered under an answer the bot did not
 * have.
 *
 * In the shape the widget already renders for a workflow's choices. The
 * widget recognises `action: 'handoff'` and asks for a person instead of
 * sending the label; one that does not sends the label, or the value, as a
 * message - and `wantsAPerson` below recognises both.
 */
function handoffChoice() {
  const label = notice('handoff_offer');
  return {
    label: label.message,
    value: HANDOFF_VALUE,
    action: 'handoff',
    ...label
  };
}

/** The value of the "Verify with your email" quick reply. */
const VERIFY_EMAIL_VALUE = '__verify_email__';

/**
 * The "Verify with your email" quick reply, offered when the visitor asks
 * for something only a verified customer may see and an email code would be
 * enough (services/visitor-verification.js#isVerifiedEnough).
 *
 * Same shape as `handoffChoice`: the widget recognises `action:
 * 'verify_email'` and opens the code form in the chat instead of sending the
 * label as a message.
 */
function verifyEmailChoice() {
  const label = notice('verify_email_offer');
  return {
    label: label.message,
    value: VERIFY_EMAIL_VALUE,
    action: 'verify_email',
    ...label
  };
}

/**
 * Fill `{name}` and `{company}` in a tenant's canned reply.
 *
 * Tenants write "Thanks {name}, someone from {company} will reply shortly"
 * and expect it to read naturally whether or not the visitor gave a name. An
 * unknown name is dropped together with the space before it, so the visitor
 * reads "Thanks, someone from Acme..." rather than "Thanks {name}," or
 * "Thanks ,".
 *
 * @param {string} text
 * @param {{name?: string, company?: string}} values
 */
function fillPlaceholders(text, values = {}) {
  if (typeof text !== 'string' || !/\{(name|company)\}/i.test(text)) {
    return text;
  }

  const fill = (input, key, value) => (value
    ? input.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value).trim())
    : input.replace(new RegExp(`[ \\t]*\\{${key}\\}`, 'gi'), ''));

  return fill(fill(text, 'name', values.name), 'company', values.company)
    // A sentence that began with the missing name now begins with its comma.
    .replace(/^[\s,]+/, '')
    .trim();
}

// Who a visitor might ask for. Deliberately a list of people, not of topics:
// "a manager" is somebody to talk to, "my account manager said..." is not a
// request (and is excluded by the length cap below).
const PERSON = String.raw`(?:a |an |the |some |real |actual |live |human )*(?:person|human|human being|someone|somebody|agent|operator|representative|rep|staff|member of staff|team member|advisor|adviser|manager|support agent|customer service)`;

const ASK_FOR_PERSON = [
  // "can I talk to a person", "I'd like to speak with someone", "connect me to an agent"
  new RegExp(String.raw`\b(?:talk|speak|chat|connect me|put me through|transfer me|get me through)\b[^.?!]*?\b(?:to|with)\s+${PERSON}\b`, 'i'),
  // "talk to a person", "human please", "agent", "a real person"
  new RegExp(String.raw`^(?:${PERSON})(?:\s+please)?$`, 'i'),
  // "I want a human", "I need someone from support"
  new RegExp(String.raw`^(?:i(?:\s+want|\s+need|\s+would like|'d like)|can i have|can i get|get me)\s+${PERSON}\b`, 'i')
];

/** Longer than this and the sentence is about something; it is not a request. */
const MAX_REQUEST_WORDS = 12;

/**
 * Whether a typed message is the visitor asking for a person.
 *
 * Conservative on purpose. Escalating somebody who was only being polite
 * hands a colleague a conversation the bot could have finished, and treating
 * "my manager asked me to check the invoice" as a request would be worse - so
 * this matches short, direct asks only, and everything else goes to the bot,
 * which can still offer a person when it has no answer.
 */
function wantsAPerson(text) {
  if (String(text || '').trim() === HANDOFF_VALUE) {
    return true;
  }

  const normalised = String(text || '')
    .toLowerCase()
    .replace(/[’]/g, '\'')
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalised) {
    return false;
  }

  if (normalised.split(' ').length > MAX_REQUEST_WORDS) {
    return false;
  }

  return ASK_FOR_PERSON.some(pattern => pattern.test(normalised));
}

module.exports = {
  CODES,
  HANDOFF_VALUE,
  VERIFY_EMAIL_VALUE,
  notice,
  handoffChoice,
  verifyEmailChoice,
  fillPlaceholders,
  wantsAPerson
};
