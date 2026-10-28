/**
 * P2D: who a visitor is, from a token the tenant signed.
 *
 * Everything the widget sends is attacker-controlled, so these pin down that a
 * token is believed only when it is signed with the company's secret, has not
 * expired, names this widget when it names anything, and lives no longer
 * than a day - and that what it proves stays with the session that proved it.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({ generateOperatorSuggestion: jest.fn().mockResolvedValue('draft') })
}));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const identity = require('../services/visitor-identity');
const contactService = require('../services/contacts');
const { isVerifiedEnough, requirementOf } = require('../services/visitor-verification');
const { createHarness, waitFor, eventually, pause, freshSessionId } = require('./ws1-socket-harness');

const SECRET = 'a'.repeat(64);
const WIDGET_KEY = 'wk_0123456789abcdef0123456789abcdef';

const now = () => Math.floor(Date.now() / 1000);
const sign = (claims, secret = SECRET, options = {}) => jwt.sign(
  { iat: now(), exp: now() + 3600, ...claims },
  secret,
  { algorithm: 'HS256', ...options }
);

describe('P2D: verifying a visitor token', () => {
  const verify = (token, extra = {}) => identity.verifyToken(token, { secret: SECRET, widgetKey: WIDGET_KEY, ...extra });

  it('accepts a correctly signed token and reads who it names', () => {
    const result = verify(sign({ sub: 'user-7', email: 'Ada@Example.com', name: 'Ada', aud: WIDGET_KEY }));
    expect(result).toMatchObject({ ok: true, method: 'jwt', externalId: 'user-7', email: 'ada@example.com', name: 'Ada' });
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('accepts a numeric sub and a token with no aud at all', () => {
    expect(verify(sign({ sub: 42 }))).toMatchObject({ ok: true, externalId: '42' });
  });

  it('refuses an expired token, and says so', () => {
    const token = sign({ sub: 'user-7', iat: now() - 7200, exp: now() - 120 });
    expect(verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('allows a minute of clock skew either way', () => {
    expect(verify(sign({ sub: 'user-7', iat: now() - 600, exp: now() - 30 })).ok).toBe(true);
    expect(verify(sign({ sub: 'user-7', iat: now() + 30, exp: now() + 600 })).ok).toBe(true);
    expect(verify(sign({ sub: 'user-7', iat: now() + 600, exp: now() + 1200 }))).toEqual({ ok: false, reason: 'issued_in_future' });
  });

  it('refuses a token signed with any other secret', () => {
    expect(verify(sign({ sub: 'user-7' }, 'b'.repeat(64)))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token whose payload was edited after signing', () => {
    const [header, , signature] = sign({ sub: 'attacker' }).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'victim', iat: now(), exp: now() + 600 })).toString('base64url');
    expect(verify(`${header}.${forged}.${signature}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token for a different widget', () => {
    expect(verify(sign({ sub: 'user-7', aud: 'wk_someone_else_entirely_000000000' })))
      .toEqual({ ok: false, reason: 'audience_mismatch' });
    expect(verify(sign({ sub: 'user-7', aud: [WIDGET_KEY, 'other'] })).ok).toBe(true);
  });

  it('refuses other algorithms, including none', () => {
    const hs512 = jwt.sign({ sub: 'user-7', iat: now(), exp: now() + 600 }, SECRET, { algorithm: 'HS512' });
    expect(verify(hs512)).toEqual({ ok: false, reason: 'bad_algorithm' });

    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'user-7', exp: now() + 600 })).toString('base64url');
    expect(verify(`${header}.${body}.`).ok).toBe(false);
  });

  it('insists on an expiry no more than a day away', () => {
    expect(verify(jwt.sign({ sub: 'user-7' }, SECRET))).toMatchObject({ ok: false });
    expect(verify(sign({ sub: 'user-7', exp: now() + 2 * 86400 }))).toEqual({ ok: false, reason: 'lifetime_too_long' });
    const noIat = jwt.sign({ sub: 'user-7', exp: now() + 2 * 86400 }, SECRET, { noTimestamp: true });
    expect(verify(noIat)).toEqual({ ok: false, reason: 'lifetime_too_long' });
    expect(verify(sign({ sub: 'user-7', exp: now() + 86400 })).ok).toBe(true);
  });

  it('insists on a subject', () => {
    expect(verify(sign({ email: 'x@example.com' }))).toEqual({ ok: false, reason: 'no_subject' });
    expect(verify(sign({ sub: '   ' }))).toEqual({ ok: false, reason: 'no_subject' });
  });

  it('keeps signed attributes it can store, and drops the rest', () => {
    const result = verify(sign({
      sub: 'user-7',
      attrs: { plan: 'gold', seats: 5, beta: true, nested: { tier: 2 }, 'bad.key': 'x', $where: 'y', empty: null, huge: 'z'.repeat(600) }
    }));
    expect(result.hasAttributes).toBe(true);
    expect(result.attributes).toEqual({ plan: 'gold', seats: '5', beta: 'true', nested: '{"tier":2}' });
  });

  it('treats garbage as malformed without throwing', () => {
    expect(verify('not-a-token')).toEqual({ ok: false, reason: 'malformed' });
    expect(verify(undefined)).toEqual({ ok: false, reason: 'malformed' });
    expect(identity.verifyToken(sign({ sub: 'x' }), {})).toEqual({ ok: false, reason: 'no_secret' });
  });
});

describe('P2D: how strongly a contact is verified', () => {
  it('lets a signature satisfy everything and an email code only what allows it', () => {
    const signed = { identityLevel: 'verified', verifiedBy: 'jwt', externalId: 'u1' };
    const legacy = { identityLevel: 'verified', externalId: 'u1' };
    const byCode = { identityLevel: 'verified', verifiedBy: 'email_code', email: 'a@b.co' };
    const claimed = { identityLevel: 'claimed', email: 'a@b.co' };

    expect(isVerifiedEnough(signed, 'signed')).toBe(true);
    expect(isVerifiedEnough(signed, 'email')).toBe(true);
    expect(isVerifiedEnough(legacy, 'signed')).toBe(true);
    expect(isVerifiedEnough(byCode, 'signed')).toBe(false);
    expect(isVerifiedEnough(byCode)).toBe(false);
    expect(isVerifiedEnough(byCode, 'email')).toBe(true);
    expect(isVerifiedEnough(claimed, 'email')).toBe(false);
    expect(isVerifiedEnough(null, 'email')).toBe(false);
  });

  it('reads an action\'s requirement, defaulting to a signature', () => {
    expect(requirementOf({ verification: 'email' })).toBe('email');
    expect(requirementOf({ verification: 'signed' })).toBe('signed');
    expect(requirementOf({})).toBe('signed');
  });
});

describe('P2D: contacts from tokens', () => {
  let company;
  let secret;

  const token = (claims, options) => sign(claims, secret, options);
  const hash = id => crypto.createHmac('sha256', secret).update(id).digest('hex');

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'P2D Identity Co' });
    const withSecret = await Company.findById(company._id).select('+identitySecret widgetKey');
    secret = withSecret.identitySecret;
    company = withSecret;
  });

  beforeEach(async () => {
    await Contact.deleteMany({ company: company._id });
    await Conversation.deleteMany({ company: company._id });
  });

  afterAll(async () => {
    await Contact.deleteMany({ company: company._id });
    await Conversation.deleteMany({ company: company._id });
    await Company.deleteMany({ name: /^P2D Identity/ });
  });

  it('a valid token makes the contact verified, with the token\'s sub and signed attributes', async () => {
    const contact = await contactService.resolve({
      companyId: company._id,
      sessionId: 's-jwt',
      userJwt: token({ sub: 'cust-1', email: 'Ada@Example.com', name: 'Ada', aud: company.widgetKey, attrs: { plan: 'gold' } })
    });

    expect(contact).toMatchObject({ identityLevel: 'verified', verifiedBy: 'jwt', externalId: 'cust-1', email: 'ada@example.com', name: 'Ada' });
    expect(contact.verifiedAt).toBeInstanceOf(Date);
    expect(contact.attributes.get('plan')).toBe('gold');
    expect(contact.signedAttributes.get('plan')).toBe('gold');
    expect(contactService.attributeList(contact)).toEqual([{ key: 'plan', value: 'gold', signed: true }]);
  });

  it('an expired, forged or foreign token leaves the visitor anonymous', async () => {
    const expired = await contactService.resolve({
      companyId: company._id, sessionId: 's-expired',
      userJwt: token({ sub: 'cust-1', iat: now() - 7200, exp: now() - 3600 })
    });
    const forged = await contactService.resolve({
      companyId: company._id, sessionId: 's-forged',
      userJwt: sign({ sub: 'cust-1' }, 'c'.repeat(64))
    });
    const foreign = await contactService.resolve({
      companyId: company._id, sessionId: 's-foreign',
      userJwt: token({ sub: 'cust-1', aud: 'wk_not_this_company_00000000000000' })
    });

    [expired, forged, foreign].forEach(contact => {
      expect(contact.identityLevel).toBe('anonymous');
      expect(contact.externalId).toBeUndefined();
    });
  });

  it('an unsigned attribute never replaces a signed one', async () => {
    await contactService.resolve({
      companyId: company._id, sessionId: 's-attrs',
      userJwt: token({ sub: 'cust-2', attrs: { plan: 'gold' } })
    });
    const after = await contactService.resolve({
      companyId: company._id, sessionId: 's-attrs',
      attributes: { plan: 'platinum', colour: 'blue' }
    });

    expect(after.attributes.get('plan')).toBe('gold');
    expect(after.attributes.get('colour')).toBe('blue');
    expect(contactService.attributeList(after)).toEqual(expect.arrayContaining([
      { key: 'plan', value: 'gold', signed: true },
      { key: 'colour', value: 'blue', signed: false }
    ]));
  });

  it('a typed address never threads a session onto a verified person', async () => {
    const victim = await contactService.resolve({
      companyId: company._id, sessionId: 's-victim',
      userJwt: token({ sub: 'victim', email: 'victim@example.com' })
    });

    const attacker = await contactService.resolve({
      companyId: company._id, sessionId: 's-attacker', email: 'victim@example.com'
    });

    expect(String(attacker._id)).not.toBe(String(victim._id));
    expect(attacker.identityLevel).toBe('claimed');
    const stored = await Contact.findById(victim._id);
    expect(stored.sessionIds).toEqual(['s-victim']);
  });

  it('a typed address or phone does not become a verified contact\'s', async () => {
    await contactService.resolve({
      companyId: company._id, sessionId: 's-typed',
      externalId: 'cust-3', userHash: hash('cust-3')
    });
    const after = await contactService.resolve({
      companyId: company._id, sessionId: 's-typed', email: 'someone.else@example.com', phone: '+100', name: 'Typed'
    });

    expect(after.identityLevel).toBe('verified');
    expect(after.email).toBeUndefined();
    expect(after.phone).toBeUndefined();
    expect(after.name).toBe('Typed');
  });

  it('signing in drops an address typed before it, unless the token carries one', async () => {
    await contactService.resolve({ companyId: company._id, sessionId: 's-before', email: 'victim@example.com' });
    const signedIn = await contactService.resolve({
      companyId: company._id, sessionId: 's-before',
      userJwt: token({ sub: 'attacker-account' })
    });

    expect(signedIn.identityLevel).toBe('verified');
    expect(signedIn.email).toBeUndefined();
  });

  it('proving an identity moves only the session that proved it out of a shared contact', async () => {
    // Two browsers that typed the same address share a claimed contact.
    const pooled = await contactService.resolve({ companyId: company._id, sessionId: 's-one', email: 'pool@example.com' });
    await contactService.resolve({ companyId: company._id, sessionId: 's-two', email: 'pool@example.com' });
    await Conversation.create({ sessionId: 's-one', company: company._id, contact: pooled._id, messages: [] });
    await Conversation.create({ sessionId: 's-two', company: company._id, contact: pooled._id, messages: [] });

    const proven = await contactService.resolve({
      companyId: company._id, sessionId: 's-one',
      userJwt: token({ sub: 'cust-4' })
    });

    expect(String(proven._id)).not.toBe(String(pooled._id));
    expect(proven.sessionIds).toEqual(['s-one']);
    const left = await Contact.findById(pooled._id);
    expect(left.identityLevel).toBe('claimed');
    expect(left.sessionIds).toEqual(['s-two']);
    expect(String((await Conversation.findOne({ sessionId: 's-one' })).contact)).toBe(String(proven._id));
    expect(String((await Conversation.findOne({ sessionId: 's-two' })).contact)).toBe(String(pooled._id));
  });

  it('browsing and then signing in folds the anonymous contact into the person', async () => {
    const browsing = await contactService.resolve({ companyId: company._id, sessionId: 's-browse' });
    const signedIn = await contactService.resolve({
      companyId: company._id, sessionId: 's-browse',
      userJwt: token({ sub: 'cust-5' })
    });

    expect(String(signedIn._id)).toBe(String(browsing._id));
    expect(signedIn).toMatchObject({ identityLevel: 'verified', externalId: 'cust-5' });
    expect(await Contact.countDocuments({ company: company._id })).toBe(1);
  });

  it('never re-points somebody\'s verified contact at a different person', async () => {
    const first = await contactService.resolve({
      companyId: company._id, sessionId: 's-shared', userJwt: token({ sub: 'first-person' })
    });
    const second = await contactService.resolve({
      companyId: company._id, sessionId: 's-shared', userJwt: token({ sub: 'second-person' })
    });

    expect(String(second._id)).not.toBe(String(first._id));
    expect((await Contact.findById(first._id)).externalId).toBe('first-person');
    expect(second.externalId).toBe('second-person');
  });

  it('answers a reconnecting browser with the id its token proves', async () => {
    expect(await identity.presentedExternalId(company._id, { userJwt: token({ sub: 'cust-6' }) })).toBe('cust-6');
    expect(await identity.presentedExternalId(company._id, { externalId: 'cust-6', userHash: hash('cust-6') })).toBe('cust-6');
    expect(await identity.presentedExternalId(company._id, { userJwt: sign({ sub: 'cust-6' }, 'd'.repeat(64)) })).toBeNull();
    expect(await identity.presentedExternalId(company._id, {})).toBeNull();
  });
});

describe('P2D: a token over the socket', () => {
  const harness = createHarness();
  let company;
  let secret;

  const token = claims => sign(claims, secret);

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    company = await Company.create({ name: 'P2D Identity Sockets', allowedDomains: [] });
    secret = (await Company.findById(company._id).select('+identitySecret')).identitySecret;
    await harness.start();
  });

  afterEach(async () => {
    harness.closeAll();
    await pause(20);
  });

  afterAll(async () => {
    await harness.stop();
    await Conversation.deleteMany({ company: company._id });
    await Contact.deleteMany({ company: company._id });
    await Company.deleteMany({ name: /^P2D Identity/ });
  });

  const visitor = async (auth = {}) => {
    const socket = await harness.connectVisitor(company.widgetKey, { auth });
    const sessionId = freshSessionId('p2d-id');
    const session = await harness.resume(socket, sessionId);
    expect(session.rejected).toBe(false);
    return { socket, sessionId, sessionToken: session.sessionToken };
  };

  it('starts the conversation as the person the handshake token names', async () => {
    const { socket, sessionId } = await visitor({ userJwt: token({ sub: 'sock-1', name: 'Grace' }) });
    harness.say(socket, 'Where is my order?');

    const conversation = await eventually(() => Conversation.findOne({ sessionId, contact: { $exists: true } }));
    const contact = await Contact.findById(conversation.contact);
    expect(contact).toMatchObject({ identityLevel: 'verified', verifiedBy: 'jwt', externalId: 'sock-1', name: 'Grace' });
  });

  it('tells the widget when the token has expired, and keeps the visitor a guest', async () => {
    const expired = token({ sub: 'sock-2', iat: now() - 7200, exp: now() - 3600 });
    const { socket, sessionId } = await visitor({ userJwt: expired });

    const told = waitFor(socket, 'notice');
    socket.emit('visitor-identity');
    expect(await told).toMatchObject({ code: 'identity_expired' });

    harness.say(socket, 'Hello');
    const conversation = await eventually(() => Conversation.findOne({ sessionId, contact: { $exists: true } }));
    expect((await Contact.findById(conversation.contact)).identityLevel).toBe('anonymous');
  });

  it('ties a conversation begun as a guest to the person once the page signs them in', async () => {
    const guest = await visitor();
    harness.say(guest.socket, 'Hello');
    const started = await eventually(() => Conversation.findOne({ sessionId: guest.sessionId, contact: { $exists: true } }));
    expect((await Contact.findById(started.contact)).identityLevel).toBe('anonymous');

    // identify({jwt}) reconnects with the token in the handshake.
    const signedIn = await harness.connectVisitor(company.widgetKey, { auth: { userJwt: token({ sub: 'sock-3' }) } });
    const resumed = await harness.resume(signedIn, guest.sessionId, guest.sessionToken);
    expect(resumed.rejected).toBe(false);
    signedIn.emit('visitor-identity');

    const linked = await eventually(async () => {
      const conversation = await Conversation.findOne({ sessionId: guest.sessionId });
      const contact = await Contact.findById(conversation.contact);
      return contact && contact.externalId === 'sock-3' ? contact : null;
    });
    expect(linked.identityLevel).toBe('verified');
  });

  it('refuses to resume a verified conversation for somebody presenting another token', async () => {
    const owner = await visitor({ userJwt: token({ sub: 'sock-owner' }) });
    harness.say(owner.socket, 'My account');
    await eventually(async () => {
      const conversation = await Conversation.findOne({ sessionId: owner.sessionId });
      return conversation && conversation.contact
        && (await Contact.findById(conversation.contact)).externalId === 'sock-owner';
    });

    const other = await harness.connectVisitor(company.widgetKey, { auth: { userJwt: token({ sub: 'sock-other' }) } });
    const attempt = await harness.resume(other, owner.sessionId, owner.sessionToken);
    expect(attempt.rejected).toBe(true);
  });
});
