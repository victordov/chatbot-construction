/**
 * Verifying an anonymous visitor by a code sent to their email address.
 *
 * "Where is my order?" can only be answered safely for somebody who has
 * proved who they are. A tenant whose site has logins can sign that (a token,
 * services/visitor-identity.js); one without - most shops, before checkout -
 * had no way to let a visitor prove anything, so verified-only actions were
 * simply unavailable to them. Here the visitor types their address, we send a
 * six-digit code through the same outbound path an operator's follow-up takes
 * (services/email-channel.js - no second mailer), and typing it back marks the
 * contact `verified` with `verifiedBy: 'email_code'`.
 *
 * A code proves the inbox, not the login. So it unlocks only the actions the
 * tenant marked "email verification is enough" (`Action.verification ===
 * 'email'`); everything else still needs the tenant's signature. That rule is
 * `isVerifiedEnough`, which whatever gates an action calls.
 *
 * Abuse limits, all counted in MongoDB so they hold across instances:
 *   - a code lives 10 minutes and allows 3 wrong guesses;
 *   - 3 codes per chat session per 10 minutes;
 *   - 5 codes per address per hour, so nobody's inbox can be flooded through
 *     many sessions;
 *   - VERIFY_EMAIL_HOURLY_LIMIT codes per tenant per hour (200 by default),
 *     so the tenant's name cannot be used to spray mail at strangers.
 *
 * Socket protocol (wired by `attach`, from websockets.js):
 *   visitor -> `verify-email-start {email, language?}`
 *     server -> `verify-email-sent {email, expiresInSeconds, code...}`, or
 *               `verify-email-result {ok: false, reason, stage: 'start', code...}`
 *   visitor -> `verify-email-code {code}`
 *     server -> `verify-email-result {ok, reason?, email?, code...}`
 *   visitor -> `visitor-identity` (after `session-ready`, when the page signed
 *              the visitor in): re-checks the identity in the handshake,
 *              attaches it to a conversation that started anonymously, and
 *              answers an expired token with the `identity_expired` notice.
 * Every reply carries a visitor-notice code (services/visitor-notices.js) the
 * widget translates.
 */

const crypto = require('crypto');

const Action = require('../models/action');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const VisitorCode = require('../models/visitor-code');
const MongoRateLimitStore = require('./rate-limit-store');
const contactService = require('./contacts');
const identity = require('./visitor-identity');
const { notice, verifyEmailChoice } = require('./visitor-notices');
const { WIDGET_LANGUAGES } = require('../config/widget-languages');
const { logger } = require('./logging');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const SESSION_LIMIT = 3;
const SESSION_WINDOW_MS = 10 * 60 * 1000;
const ADDRESS_LIMIT = 5;
const ADDRESS_WINDOW_MS = 60 * 60 * 1000;
const COMPANY_WINDOW_MS = 60 * 60 * 1000;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const CODE_FORMAT = /^\d{6}$/;

/** The requirement an action states, as `isVerifiedEnough` takes it. */
const REQUIREMENTS = ['signed', 'email'];

const limits = {
  session: new MongoRateLimitStore({ prefix: 'verify-email:session', windowMs: SESSION_WINDOW_MS }),
  address: new MongoRateLimitStore({ prefix: 'verify-email:address', windowMs: ADDRESS_WINDOW_MS }),
  company: new MongoRateLimitStore({ prefix: 'verify-email:company', windowMs: COMPANY_WINDOW_MS })
};

function companyHourlyLimit() {
  const value = parseInt(process.env.VERIFY_EMAIL_HOURLY_LIMIT, 10);
  return Number.isFinite(value) && value > 0 ? value : 200;
}

// ------------------------------------------------------------ the rule

/**
 * Whether a contact is verified strongly enough for something that needs it.
 *
 * `signed` (the default, and what every action was before email codes
 * existed) is satisfied only by the tenant's own signature - a token or a
 * hash. `email` is satisfied by that, or by an email address proven with a
 * code. Anything not verified satisfies neither.
 *
 * @param {object|null} contact a Contact, or a plain object with
 *        `identityLevel`, `verifiedBy`, `externalId`
 * @param {'signed'|'email'} [requirement]
 * @returns {boolean}
 */
function isVerifiedEnough(contact, requirement = 'signed') {
  if (!contact || contact.identityLevel !== 'verified') {
    return false;
  }
  if (identity.isSigned(contact)) {
    return true;
  }
  return requirement === 'email' && contact.verifiedBy === 'email_code';
}

/** What an action asks for: `email` only when the tenant said so. */
function requirementOf(action) {
  return action && action.verification === 'email' ? 'email' : 'signed';
}

// ------------------------------------------------------------ the email

/**
 * The message, in the language the visitor is chatting in. The widget sends
 * its language with the request; anything else falls back to English.
 */
const EMAIL_TEXT = {
  en: {
    subject: 'Your verification code is {code}',
    body: [
      '{code} is your code to confirm your email address in the chat with {company}.',
      'It expires in 10 minutes.',
      'If you did not ask for this, you can ignore this email.'
    ]
  },
  es: {
    subject: 'Tu código de verificación es {code}',
    body: [
      '{code} es tu código para confirmar tu dirección de correo en el chat con {company}.',
      'Caduca en 10 minutos.',
      'Si no lo has pedido, puedes ignorar este correo.'
    ]
  },
  fr: {
    subject: 'Votre code de vérification est {code}',
    body: [
      '{code} est votre code pour confirmer votre adresse e-mail dans la discussion avec {company}.',
      'Il expire dans 10 minutes.',
      'Si vous n’avez rien demandé, vous pouvez ignorer cet e-mail.'
    ]
  },
  de: {
    subject: 'Ihr Bestätigungscode lautet {code}',
    body: [
      '{code} ist Ihr Code, um Ihre E-Mail-Adresse im Chat mit {company} zu bestätigen.',
      'Er ist 10 Minuten lang gültig.',
      'Wenn Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren.'
    ]
  },
  it: {
    subject: 'Il tuo codice di verifica è {code}',
    body: [
      '{code} è il tuo codice per confermare il tuo indirizzo email nella chat con {company}.',
      'Scade tra 10 minuti.',
      'Se non l’hai richiesto, puoi ignorare questa email.'
    ]
  },
  pt: {
    subject: 'Seu código de verificação é {code}',
    body: [
      '{code} é o seu código para confirmar seu e-mail no chat com {company}.',
      'Ele expira em 10 minutos.',
      'Se você não pediu este código, pode ignorar este e-mail.'
    ]
  },
  ro: {
    subject: 'Codul tău de verificare este {code}',
    body: [
      '{code} este codul tău pentru a-ți confirma adresa de e-mail în chatul cu {company}.',
      'Expiră în 10 minute.',
      'Dacă nu l-ai cerut, poți ignora acest e-mail.'
    ]
  },
  ru: {
    subject: 'Ваш код подтверждения: {code}',
    body: [
      '{code} — ваш код для подтверждения адреса эл. почты в чате с {company}.',
      'Он действует 10 минут.',
      'Если вы его не запрашивали, просто проигнорируйте это письмо.'
    ]
  },
  uk: {
    subject: 'Ваш код підтвердження: {code}',
    body: [
      '{code} — ваш код для підтвердження адреси ел. пошти в чаті з {company}.',
      'Він дійсний 10 хвилин.',
      'Якщо ви його не запитували, просто проігноруйте цей лист.'
    ]
  },
  pl: {
    subject: 'Twój kod weryfikacyjny to {code}',
    body: [
      '{code} to Twój kod do potwierdzenia adresu e-mail na czacie z {company}.',
      'Kod wygasa za 10 minut.',
      'Jeśli to nie Ty o niego prosisz, zignoruj tę wiadomość.'
    ]
  },
  nl: {
    subject: 'Je verificatiecode is {code}',
    body: [
      '{code} is je code om je e-mailadres te bevestigen in de chat met {company}.',
      'De code verloopt over 10 minuten.',
      'Heb je hier niet om gevraagd? Dan kun je deze e-mail negeren.'
    ]
  }
};

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] !== undefined ? values[key] : match));
}

/** Subject and body for one code, in one language. */
function composeEmail(code, companyName, language) {
  const words = EMAIL_TEXT[WIDGET_LANGUAGES.includes(language) ? language : 'en'] || EMAIL_TEXT.en;
  const values = { code, company: companyName || 'us' };
  return {
    subject: fill(words.subject, values),
    text: words.body.map(line => fill(line, values)).join('\n\n')
  };
}

/**
 * The transport and sender an operator's follow-up would use for this
 * tenant, or null when this server cannot send mail.
 */
async function outbound(companyId) {
  // Required lazily: email-channel pulls in the conversation lifecycle,
  // which pulls in contacts, which this file also needs at load.
  const emailChannel = require('./email-channel');
  const transport = emailChannel.buildTransport();
  if (!transport) {
    return null;
  }

  const company = await Company.findById(companyId).select('name emailChannel').lean();
  if (!company) {
    return null;
  }

  const sender = emailChannel.senderFor(company, company.emailChannel || {});
  return sender ? { transport, sender, company } : null;
}

/** Whether this server can send a tenant's visitors a code at all. */
async function isAvailable(companyId) {
  try {
    return Boolean(companyId && await outbound(companyId));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ codes

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** A key for counting per address that does not store the address. */
function addressKey(companyId, email) {
  return `${companyId}:${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
}

async function overLimit(store, key, limit) {
  const { totalHits } = await store.increment(key);
  return totalHits > limit;
}

/** Normalise what the visitor typed, or null when it is not an address. */
function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email && email.length <= MAX_EMAIL_LENGTH && EMAIL_ADDRESS.test(email) ? email : null;
}

/**
 * Send a code to the address a visitor typed.
 *
 * @param {object} input
 * @param {string} input.companyId
 * @param {string} input.sessionId the session the socket is bound to
 * @param {string} input.email
 * @param {string} [input.language] the widget's language, for the email
 * @returns {Promise<{ok: true, email: string, expiresAt: Date}
 *          |{ok: true, alreadyVerified: true, email: string}
 *          |{ok: false, reason: string}>}
 */
async function start({ companyId, sessionId, email, language } = {}) {
  if (!companyId || !sessionId) {
    return { ok: false, reason: 'unavailable' };
  }

  const address = cleanEmail(email);
  if (!address) {
    return { ok: false, reason: 'invalid_email' };
  }

  // Somebody already proven - signed in, or this very address by code -
  // has nothing to prove; sending them a code would only be noise.
  const current = await Contact.findOne({ company: companyId, sessionIds: sessionId })
    .select('identityLevel verifiedBy externalId email').lean();
  if (current && (identity.isSigned(current) ||
      (current.verifiedBy === 'email_code' && current.identityLevel === 'verified' && current.email === address))) {
    return { ok: true, alreadyVerified: true, email: current.email || address };
  }

  const mail = await outbound(companyId);
  if (!mail) {
    logger.warn('A visitor asked for an email code, but this server cannot send mail (EMAIL_HOST, EMAIL_FROM)', {
      companyId: String(companyId)
    });
    return { ok: false, reason: 'unavailable' };
  }

  // Every limit is counted whether or not the others pass, so hammering one
  // does not leave the rest untouched.
  const [sessionOver, addressOver, companyOver] = await Promise.all([
    overLimit(limits.session, `${companyId}:${sessionId}`, SESSION_LIMIT),
    overLimit(limits.address, addressKey(companyId, address), ADDRESS_LIMIT),
    overLimit(limits.company, String(companyId), companyHourlyLimit())
  ]);
  if (sessionOver || addressOver || companyOver) {
    logger.warn('Email verification code refused by a rate limit', {
      companyId: String(companyId),
      limit: sessionOver ? 'session' : (addressOver ? 'address' : 'company')
    });
    return { ok: false, reason: 'rate_limited' };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // One live code per session: asking again replaces the last one.
  await VisitorCode.findOneAndUpdate(
    { company: companyId, sessionId },
    { $set: { email: address, codeHash: hashCode(code, salt), salt, attempts: 0, expiresAt, createdAt: new Date() } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const { subject, text } = composeEmail(code, mail.company.name, language);

  try {
    await mail.transport.sendMail({
      from: mail.sender.from,
      to: address,
      replyTo: mail.sender.replyTo,
      subject,
      text
    });
  } catch (error) {
    await VisitorCode.deleteOne({ company: companyId, sessionId });
    logger.error('Could not send an email verification code', {
      companyId: String(companyId),
      error: error.message
    });
    return { ok: false, reason: 'send_failed' };
  }

  logger.info('Sent an email verification code', { companyId: String(companyId) });
  return { ok: true, email: address, expiresAt };
}

/**
 * Check the code a visitor typed back, and verify them if it is right.
 *
 * Each guess is counted before it is compared, atomically, so two guesses
 * sent together cannot both slip in under the limit.
 *
 * @returns {Promise<{ok: true, email: string, contact: object}
 *          |{ok: false, reason: string, attemptsLeft?: number}>}
 */
async function check({ companyId, sessionId, code } = {}) {
  if (!companyId || !sessionId) {
    return { ok: false, reason: 'unavailable' };
  }

  const typed = String(code === undefined || code === null ? '' : code).replace(/\s+/g, '');
  if (!CODE_FORMAT.test(typed)) {
    return { ok: false, reason: 'invalid_code' };
  }

  const pending = await VisitorCode.findOne({ company: companyId, sessionId }).lean();
  if (!pending) {
    return { ok: false, reason: 'no_code' };
  }
  if (pending.expiresAt.getTime() <= Date.now()) {
    await VisitorCode.deleteOne({ _id: pending._id });
    return { ok: false, reason: 'expired' };
  }

  const counted = await VisitorCode.findOneAndUpdate(
    { _id: pending._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!counted) {
    await VisitorCode.deleteOne({ _id: pending._id });
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!sameHash(hashCode(typed, counted.salt), counted.codeHash)) {
    if (counted.attempts >= MAX_ATTEMPTS) {
      await VisitorCode.deleteOne({ _id: counted._id });
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'wrong_code', attemptsLeft: MAX_ATTEMPTS - counted.attempts };
  }

  // Used once: whoever deletes it is the one it verifies.
  const consumed = await VisitorCode.deleteOne({ _id: counted._id });
  if (!consumed.deletedCount) {
    return { ok: false, reason: 'no_code' };
  }

  const result = await contactService.verifyEmail({ companyId, sessionId, email: counted.email });
  if (!result) {
    return { ok: false, reason: 'unavailable' };
  }

  await recordOnConversation(companyId, sessionId, result.contact, counted.email);

  return { ok: true, email: counted.email, contact: result.contact };
}

/**
 * Tie a conversation already under way to the verified contact, and tell
 * the operators in its transcript.
 *
 * A session that has not started a conversation yet needs nothing: it is
 * created with the contact this session now belongs to.
 */
async function recordOnConversation(companyId, sessionId, contact, email) {
  try {
    const conversation = await Conversation.findOne({ sessionId, company: companyId });
    if (!conversation) {
      return;
    }

    if (!conversation.contact || !conversation.contact.equals(contact._id)) {
      await contactService.linkConversation(contact, conversation);
    }

    const lifecycle = require('./conversation-lifecycle');
    const line = lifecycle.addSystemLine(conversation, `Verified their email address (${email}) with a one-time code`);
    await conversation.save();

    const socketManager = require('../socketManager');
    lifecycle.announceMessages(conversation, [line], {
      operators: (event, payload) => socketManager.emitToOperators(companyId, event, payload)
    });
  } catch (error) {
    // The visitor is verified either way; the transcript line is a courtesy.
    logger.warn('Could not note an email verification on the conversation', { error: error.message });
  }
}

// ------------------------------------------------------------ offering it

/**
 * Whether proving an email address would unlock anything for this contact:
 * the tenant has at least one live action marked "email verification is
 * enough", the contact is not already verified that far, and this server can
 * send the code. What the assistant checks before offering
 * `verifyEmailChoice()`.
 *
 * @returns {Promise<boolean>}
 */
async function wouldUnlock(companyId, contact) {
  if (!companyId || isVerifiedEnough(contact, 'email')) {
    return false;
  }
  try {
    const candidates = await Action.find({ company: companyId, enabled: true, verification: 'email' })
      .select('requiresVerified inputs')
      .lean();
    const actions = require('./actions');
    if (!candidates.some(action => actions.needsVerified(action))) {
      return false;
    }
    return await isAvailable(companyId);
  } catch (error) {
    logger.warn('Could not tell whether email verification would help', { error: error.message });
    return false;
  }
}

/**
 * Ask the visitor on a session to verify their email: the widget opens the
 * code form in the chat. For an operator's "ask them to verify" or a flow.
 */
function askVisitor(sessionId) {
  const socketManager = require('../socketManager');
  return socketManager.emitToVisitor(sessionId, 'verify-email-request', notice('verify_email_offer'));
}

// ------------------------------------------------------------ sockets

/** The visitor-notice code for each outcome. */
const NOTICE_FOR = {
  invalid_email: 'verify_email_invalid',
  rate_limited: 'verify_email_rate_limited',
  send_failed: 'verify_email_send_failed',
  unavailable: 'verify_email_unavailable',
  invalid_code: 'verify_email_invalid_code',
  wrong_code: 'verify_email_wrong_code',
  expired: 'verify_email_expired',
  no_code: 'verify_email_no_code',
  too_many_attempts: 'verify_email_too_many_attempts'
};

function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra, ...notice(NOTICE_FOR[reason] || 'verify_email_unavailable') };
}

/**
 * Listen for a visitor's verification events on their socket.
 *
 * Called once per connection from websockets.js. `context` reads that
 * connection's state lazily, because the session is bound after connecting:
 *
 *   session()  the session id the socket has proved it owns, or null
 *   company()  the tenant's id (may return a promise)
 *   isOperator true for staff sockets, which get nothing here
 *
 * The session in an event payload is ignored, as everywhere else: only the
 * bound one counts.
 */
function attach(socket, context = {}) {
  if (!socket || context.isOperator) {
    return;
  }

  const sessionOf = () => (typeof context.session === 'function' ? context.session() : null);
  const companyOf = async () => (typeof context.company === 'function' ? context.company() : null);
  const languageOf = value => (typeof value === 'string' && WIDGET_LANGUAGES.includes(value) ? value : 'en');

  socket.on('verify-email-start', async (data = {}) => {
    try {
      const sessionId = sessionOf();
      const companyId = sessionId ? await companyOf() : null;
      const result = await start({
        companyId,
        sessionId,
        email: data && data.email,
        language: languageOf(data && data.language)
      });

      if (result.ok && result.alreadyVerified) {
        socket.emit('verify-email-result', {
          ok: true,
          reason: 'already_verified',
          email: result.email,
          ...notice('verify_email_verified', { email: result.email })
        });
        return;
      }
      if (result.ok) {
        socket.emit('verify-email-sent', {
          email: result.email,
          expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
          ...notice('verify_email_sent', { email: result.email })
        });
        return;
      }
      socket.emit('verify-email-result', failure(result.reason, { stage: 'start' }));
    } catch (error) {
      logger.error('Email verification could not start', { error: error.message });
      socket.emit('verify-email-result', failure('unavailable', { stage: 'start' }));
    }
  });

  socket.on('verify-email-code', async (data = {}) => {
    try {
      const sessionId = sessionOf();
      const companyId = sessionId ? await companyOf() : null;
      const result = await check({ companyId, sessionId, code: data && data.code });

      if (result.ok) {
        socket.emit('verify-email-result', {
          ok: true,
          email: result.email,
          ...notice('verify_email_verified', { email: result.email })
        });
        return;
      }
      socket.emit('verify-email-result', failure(result.reason, {
        stage: 'code',
        ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {})
      }));
    } catch (error) {
      logger.error('Email verification code could not be checked', { error: error.message });
      socket.emit('verify-email-result', failure('unavailable', { stage: 'code' }));
    }
  });

  socket.on('visitor-identity', async () => {
    try {
      const sessionId = sessionOf();
      const companyId = sessionId ? await companyOf() : null;
      if (!companyId) {
        return;
      }
      await reviewIdentity(socket, companyId, sessionId);
    } catch (error) {
      logger.warn('Could not review a visitor\'s identity', { error: error.message });
    }
  });
}

/**
 * The identity a connection was opened with, looked at again once its
 * session is bound.
 *
 * An expired token is answered with the `identity_expired` notice, so the
 * page can fetch a fresh one. A good one is attached to a conversation that
 * started before the page signed the visitor in - otherwise it would stay
 * anonymous until the next form - and its signed details are refreshed. A
 * conversation that has not started yet needs nothing: it is created with
 * the identity in the handshake.
 */
async function reviewIdentity(socket, companyId, sessionId) {
  const auth = (socket.handshake && socket.handshake.auth) || {};
  const hints = {
    userJwt: typeof auth.userJwt === 'string' ? auth.userJwt : undefined,
    externalId: auth.externalId,
    userHash: auth.userHash
  };

  const proof = await identity.prove(companyId, hints);
  if (!proof) {
    return;
  }
  if (!proof.ok) {
    if (proof.reason === 'expired') {
      socket.emit('notice', notice('identity_expired'));
    }
    return;
  }

  const conversation = await Conversation.findOne({ sessionId, company: companyId }).select('contact');
  if (!conversation) {
    return;
  }

  const holder = conversation.contact
    ? await Contact.findById(conversation.contact).select('externalId identityLevel').lean()
    : null;
  // Somebody else's verified conversation is refused at resume
  // (websockets.js#identityMatches); never re-point it here.
  if (holder && holder.externalId && holder.externalId !== proof.externalId) {
    return;
  }
  // Already this person, and a hash has nothing more to say.
  if (holder && holder.externalId === proof.externalId && proof.method !== 'jwt') {
    return;
  }

  const contact = await contactService.resolve({ companyId, sessionId, ...hints });
  if (!contact) {
    return;
  }

  // Resolving may already have moved the conversation, when the session's
  // anonymous contact was folded into the person; read where it is now.
  const now = await Conversation.findById(conversation._id).select('contact').lean();
  if (now && String(now.contact) !== String(contact._id)) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { contact: contact._id } });
    await Contact.updateOne({ _id: contact._id }, { $inc: { conversationCount: 1 } });
  }
}

module.exports = {
  attach,
  start,
  check,
  isVerifiedEnough,
  requirementOf,
  wouldUnlock,
  isAvailable,
  askVisitor,
  verifyEmailChoice,
  composeEmail,
  REQUIREMENTS,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  SESSION_LIMIT,
  ADDRESS_LIMIT
};
