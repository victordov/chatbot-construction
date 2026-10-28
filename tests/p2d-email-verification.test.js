/**
 * P2D: a visitor proving their email address with a code.
 *
 * The code goes out through the same transport an operator's follow-up uses
 * (nodemailer is mocked: nothing is sent). What is pinned down: a code is
 * six digits, lives ten minutes, allows three guesses, is rate-limited per
 * session and per address, and on success makes the contact verified by
 * `email_code` - which is not the same as signed, and never joins a signed
 * contact.
 */

jest.mock('../services/reply', () => ({
  generate: jest.fn().mockResolvedValue({ text: 'A reply from the bot', source: 'assistant', path: 'assistant' })
}));

jest.mock('../services/ai', () => ({
  forCompany: jest.fn().mockResolvedValue({ generateOperatorSuggestion: jest.fn().mockResolvedValue('draft') })
}));

const mockSendMail = jest.fn().mockResolvedValue({});
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail }))
}));

const mongoose = require('mongoose');

const Action = require('../models/action');
const Company = require('../models/company');
const Contact = require('../models/contact');
const Conversation = require('../models/conversation');
const VisitorCode = require('../models/visitor-code');
const contactService = require('../services/contacts');
const verification = require('../services/visitor-verification');
const { createHarness, waitFor, eventually, pause, freshSessionId } = require('./ws1-socket-harness');

const ENV = ['EMAIL_HOST', 'EMAIL_FROM', 'EMAIL_USER', 'PRODUCT_NAME', 'VERIFY_EMAIL_HOURLY_LIMIT'];

let counter = 0;
const unique = prefix => `${prefix}-${Date.now()}-${(counter += 1)}`;
const address = prefix => `${unique(prefix)}@example.com`;

/** The code in the last email sent. */
const lastCode = () => {
  const mail = mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1][0];
  return /\b(\d{6})\b/.exec(mail.subject)[1];
};

const wrongCode = code => String((Number(code) + 1) % 1000000).padStart(6, '0');

describe('P2D: email verification codes', () => {
  const saved = {};
  let company;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    ENV.forEach(key => {
      saved[key] = process.env[key];
    });
    process.env.EMAIL_HOST = 'smtp.platform.test';
    process.env.EMAIL_FROM = 'replies@platform.test';
    process.env.PRODUCT_NAME = 'Helpdesk';
    delete process.env.VERIFY_EMAIL_HOURLY_LIMIT;

    company = await Company.create({ name: 'P2D Verify Shop' });
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({});
  });

  afterAll(async () => {
    ENV.forEach(key => {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    });
    await Promise.all([
      Contact.deleteMany({ company: company._id }),
      Conversation.deleteMany({ company: company._id }),
      VisitorCode.deleteMany({ company: company._id }),
      Action.deleteMany({ company: company._id })
    ]);
    await Company.deleteMany({ name: /^P2D Verify/ });
  });

  it('sends a six-digit code under the tenant\'s name, and keeps only its hash', async () => {
    const sessionId = unique('send');
    const email = address('send');
    const result = await verification.start({ companyId: company._id, sessionId, email: email.toUpperCase() });

    expect(result).toMatchObject({ ok: true, email });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe(email);
    expect(mail.from).toBe('"P2D Verify Shop (via Helpdesk)" <replies@platform.test>');
    expect(mail.subject).toMatch(/^Your verification code is \d{6}$/);
    expect(mail.text).toContain('P2D Verify Shop');
    expect(mail.text).toContain('10 minutes');

    const stored = await VisitorCode.findOne({ company: company._id, sessionId }).lean();
    expect(stored.email).toBe(email);
    expect(stored.codeHash).not.toContain(lastCode());
    expect(JSON.stringify(stored)).not.toContain(`"${lastCode()}"`);
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('writes the email in the visitor\'s language', async () => {
    await verification.start({ companyId: company._id, sessionId: unique('lang'), email: address('lang'), language: 'de' });
    expect(mockSendMail.mock.calls[0][0].subject).toMatch(/^Ihr Bestätigungscode lautet \d{6}$/);
    expect(verification.composeEmail('123456', 'Acme', 'xx').subject).toBe('Your verification code is 123456');
  });

  it('refuses something that is not an address', async () => {
    expect(await verification.start({ companyId: company._id, sessionId: unique('bad'), email: 'not an email' }))
      .toEqual({ ok: false, reason: 'invalid_email' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('says verification is unavailable when this server cannot send mail', async () => {
    delete process.env.EMAIL_HOST;
    try {
      expect(await verification.start({ companyId: company._id, sessionId: unique('nomail'), email: address('nomail') }))
        .toEqual({ ok: false, reason: 'unavailable' });
      expect(await verification.isAvailable(company._id)).toBe(false);
    } finally {
      process.env.EMAIL_HOST = 'smtp.platform.test';
    }
    expect(await verification.isAvailable(company._id)).toBe(true);
  });

  it('a send that fails leaves no code behind', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('relay down'));
    const sessionId = unique('fail');
    expect(await verification.start({ companyId: company._id, sessionId, email: address('fail') }))
      .toEqual({ ok: false, reason: 'send_failed' });
    expect(await VisitorCode.countDocuments({ company: company._id, sessionId })).toBe(0);
  });

  it('allows three codes per session in ten minutes', async () => {
    const sessionId = unique('session-limit');
    for (let i = 0; i < verification.SESSION_LIMIT; i += 1) {
      expect((await verification.start({ companyId: company._id, sessionId, email: address('sl') })).ok).toBe(true);
    }
    expect(await verification.start({ companyId: company._id, sessionId, email: address('sl') }))
      .toEqual({ ok: false, reason: 'rate_limited' });
    expect(mockSendMail).toHaveBeenCalledTimes(verification.SESSION_LIMIT);
  });

  it('allows five codes per address an hour, however many sessions ask', async () => {
    const email = address('address-limit');
    for (let i = 0; i < verification.ADDRESS_LIMIT; i += 1) {
      expect((await verification.start({ companyId: company._id, sessionId: unique('al'), email })).ok).toBe(true);
    }
    expect(await verification.start({ companyId: company._id, sessionId: unique('al'), email }))
      .toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('caps what one tenant can send in an hour', async () => {
    const capped = await Company.create({ name: 'P2D Verify Capped' });
    process.env.VERIFY_EMAIL_HOURLY_LIMIT = '2';
    try {
      expect((await verification.start({ companyId: capped._id, sessionId: unique('cap'), email: address('cap') })).ok).toBe(true);
      expect((await verification.start({ companyId: capped._id, sessionId: unique('cap'), email: address('cap') })).ok).toBe(true);
      expect(await verification.start({ companyId: capped._id, sessionId: unique('cap'), email: address('cap') }))
        .toEqual({ ok: false, reason: 'rate_limited' });
    } finally {
      delete process.env.VERIFY_EMAIL_HOURLY_LIMIT;
    }
  });

  it('allows three guesses, then spends the code', async () => {
    const sessionId = unique('guess');
    await verification.start({ companyId: company._id, sessionId, email: address('guess') });
    const code = lastCode();

    expect(await verification.check({ companyId: company._id, sessionId, code: wrongCode(code) }))
      .toEqual({ ok: false, reason: 'wrong_code', attemptsLeft: 2 });
    expect(await verification.check({ companyId: company._id, sessionId, code: wrongCode(code) }))
      .toEqual({ ok: false, reason: 'wrong_code', attemptsLeft: 1 });
    expect(await verification.check({ companyId: company._id, sessionId, code: wrongCode(code) }))
      .toEqual({ ok: false, reason: 'too_many_attempts' });
    // Even the right code is no use now.
    expect(await verification.check({ companyId: company._id, sessionId, code }))
      .toEqual({ ok: false, reason: 'no_code' });
  });

  it('does not count something that is not a code as a guess', async () => {
    const sessionId = unique('format');
    await verification.start({ companyId: company._id, sessionId, email: address('format') });
    expect(await verification.check({ companyId: company._id, sessionId, code: '12ab' }))
      .toEqual({ ok: false, reason: 'invalid_code' });
    expect((await VisitorCode.findOne({ company: company._id, sessionId })).attempts).toBe(0);
  });

  it('refuses a code after ten minutes', async () => {
    const sessionId = unique('expiry');
    await verification.start({ companyId: company._id, sessionId, email: address('expiry') });
    const code = lastCode();
    await VisitorCode.updateOne({ company: company._id, sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await verification.check({ companyId: company._id, sessionId, code })).toEqual({ ok: false, reason: 'expired' });
    expect(await verification.check({ companyId: company._id, sessionId, code })).toEqual({ ok: false, reason: 'no_code' });
  });

  it('only the session that asked can use the code', async () => {
    const sessionId = unique('owner');
    await verification.start({ companyId: company._id, sessionId, email: address('owner') });
    expect(await verification.check({ companyId: company._id, sessionId: unique('thief'), code: lastCode() }))
      .toEqual({ ok: false, reason: 'no_code' });
  });

  it('the right code verifies the contact by email code, and records it on the conversation', async () => {
    const sessionId = unique('success');
    const email = address('success');
    const anonymous = await contactService.resolve({ companyId: company._id, sessionId });
    const conversation = await Conversation.create({ sessionId, company: company._id, contact: anonymous._id, messages: [] });

    await verification.start({ companyId: company._id, sessionId, email });
    const result = await verification.check({ companyId: company._id, sessionId, code: lastCode() });

    expect(result).toMatchObject({ ok: true, email });
    const contact = await Contact.findById(result.contact._id);
    expect(contact).toMatchObject({ identityLevel: 'verified', verifiedBy: 'email_code', email });
    expect(contact.externalId).toBeUndefined();
    expect(verification.isVerifiedEnough(contact, 'email')).toBe(true);
    expect(verification.isVerifiedEnough(contact, 'signed')).toBe(false);

    const stored = await Conversation.findById(conversation._id);
    expect(String(stored.contact)).toBe(String(contact._id));
    expect(stored.messages.some(message => message.sender === 'system' && message.content.includes(email))).toBe(true);
    // The code is used up.
    expect(await VisitorCode.countDocuments({ company: company._id, sessionId })).toBe(0);
  });

  it('a second browser proving the same address joins the same person', async () => {
    const email = address('twice');
    const first = unique('twice-a');
    const second = unique('twice-b');

    await verification.start({ companyId: company._id, sessionId: first, email });
    const one = await verification.check({ companyId: company._id, sessionId: first, code: lastCode() });
    await verification.start({ companyId: company._id, sessionId: second, email });
    const two = await verification.check({ companyId: company._id, sessionId: second, code: lastCode() });

    expect(String(two.contact._id)).toBe(String(one.contact._id));
    expect((await Contact.findById(one.contact._id)).sessionIds).toEqual(expect.arrayContaining([first, second]));
  });

  it('never joins a contact the tenant signed, even with the same address', async () => {
    const email = address('signed');
    const crypto = require('crypto');
    const withSecret = await Company.findById(company._id).select('+identitySecret');
    const signed = await contactService.resolve({
      companyId: company._id,
      sessionId: unique('signed-owner'),
      externalId: 'signed-1',
      userHash: crypto.createHmac('sha256', withSecret.identitySecret).update('signed-1').digest('hex')
    });
    await Contact.updateOne({ _id: signed._id }, { $set: { email } });

    const sessionId = unique('signed-visitor');
    await verification.start({ companyId: company._id, sessionId, email });
    const result = await verification.check({ companyId: company._id, sessionId, code: lastCode() });

    expect(String(result.contact._id)).not.toBe(String(signed._id));
    expect(result.contact.externalId).toBeUndefined();
    expect((await Contact.findById(signed._id)).sessionIds).not.toContain(sessionId);
  });

  it('does not send a code to somebody already verified for that address', async () => {
    const sessionId = unique('already');
    const email = address('already');
    await verification.start({ companyId: company._id, sessionId, email });
    await verification.check({ companyId: company._id, sessionId, code: lastCode() });
    mockSendMail.mockClear();

    expect(await verification.start({ companyId: company._id, sessionId, email }))
      .toEqual({ ok: true, alreadyVerified: true, email });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('tells the assistant whether a code would unlock anything', async () => {
    const contact = { identityLevel: 'anonymous' };
    expect(await verification.wouldUnlock(company._id, contact)).toBe(false);

    await Action.create({
      company: company._id,
      name: 'order_status',
      title: 'Order status',
      request: { url: 'https://shop.example.com/orders' },
      requiresVerified: true,
      verification: 'email'
    });
    expect(await verification.wouldUnlock(company._id, contact)).toBe(true);
    expect(await verification.wouldUnlock(company._id, { identityLevel: 'verified', verifiedBy: 'email_code' })).toBe(false);
  });

  it('in a flow, a verified visitor with no account id counts as proven by code', async () => {
    const actions = require('../services/actions');
    const workflowActions = require('../services/workflow-actions');
    const execute = jest.spyOn(workflowActions, 'execute')
      .mockResolvedValue({ ok: true, status: 200, extracted: {}, variables: {}, durationMs: 1 });

    try {
      // Keyed on the email address, which a code does prove - but the tenant
      // has not said a code is enough.
      const signedOnly = await Action.create({
        company: company._id,
        name: 'account_balance',
        title: 'Account balance',
        request: { url: 'https://shop.example.com/balance' },
        inputs: [{ name: 'email', source: 'verified', attribute: 'email' }]
      });
      const variables = { contact_verified: 'true', contact_external_id: '', contact_email: 'ada@example.com' };

      const refused = await actions.runForWorkflow(company._id, signedOnly._id, variables, { simulate: true });
      expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/verified customer/) });
      expect(execute).not.toHaveBeenCalled();

      await Action.updateOne({ _id: signedOnly._id }, { $set: { verification: 'email' } });
      const allowed = await actions.runForWorkflow(company._id, signedOnly._id, variables, { simulate: true });
      expect(allowed.ok).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toEqual({ email: 'ada@example.com' });
    } finally {
      execute.mockRestore();
    }
  });
});

describe('P2D: what an email code unlocks', () => {
  const actions = require('../services/actions');
  const lookup = verification => ({
    requiresVerified: true,
    verification,
    inputs: [{ name: 'email', source: 'verified', attribute: 'email', required: true }]
  });
  const byCode = { identityLevel: 'verified', verifiedBy: 'email_code', email: 'ada@example.com' };
  const signed = { identityLevel: 'verified', verifiedBy: 'jwt', externalId: 'u1', email: 'ada@example.com' };

  it('runs an action marked "email is enough" for a visitor proven by code', () => {
    expect(actions.resolveInputs(lookup('email'), {}, { contact: byCode }))
      .toEqual({ ok: true, values: { email: 'ada@example.com' } });
  });

  it('never runs a signed-only action for them, whoever offered it', () => {
    expect(actions.resolveInputs(lookup('signed'), {}, { contact: byCode }).ok).toBe(false);
    expect(actions.resolveInputs(lookup(undefined), {}, { contact: byCode }).ok).toBe(false);
    expect(actions.resolveInputs(lookup('signed'), {}, { contact: signed }).ok).toBe(true);
    expect(actions.resolveInputs(lookup('email'), {}, { contact: null }).ok).toBe(false);
  });

  it('stores and shows the flag on an action', () => {
    const { value } = actions.normalise({
      name: 'order_status', title: 'Order status', request: { url: 'https://shop.example.com/orders' },
      requiresVerified: true, verification: 'email'
    });
    expect(value.verification).toBe('email');
    expect(actions.present({ ...value, verification: 'email' }).verification).toBe('email');
    expect(actions.present({ ...value, verification: undefined }).verification).toBe('signed');
  });
});

describe('P2D: email verification over the socket', () => {
  const harness = createHarness();
  const saved = {};
  let company;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI);
    }
    ENV.forEach(key => {
      saved[key] = process.env[key];
    });
    process.env.EMAIL_HOST = 'smtp.platform.test';
    process.env.EMAIL_FROM = 'replies@platform.test';
    company = await Company.create({ name: 'P2D Verify Sockets' });
    await harness.start();
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({});
  });

  afterEach(async () => {
    harness.closeAll();
    await pause(20);
  });

  afterAll(async () => {
    await harness.stop();
    ENV.forEach(key => {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    });
    await Promise.all([
      Contact.deleteMany({ company: company._id }),
      Conversation.deleteMany({ company: company._id }),
      VisitorCode.deleteMany({ company: company._id })
    ]);
    await Company.deleteMany({ name: /^P2D Verify/ });
  });

  it('sends a code and verifies the visitor who types it back', async () => {
    const { socket, sessionId } = await harness.startVisitor('p2d-verify', company.widgetKey);
    harness.say(socket, 'Where is my order?');
    await eventually(() => Conversation.findOne({ sessionId, contact: { $exists: true } }));

    const email = address('socket');
    const sent = waitFor(socket, 'verify-email-sent');
    socket.emit('verify-email-start', { email, language: 'fr' });
    expect(await sent).toMatchObject({ email, code: 'verify_email_sent', params: { email }, expiresInSeconds: 600 });
    expect(mockSendMail.mock.calls[0][0].subject).toMatch(/^Votre code de vérification est \d{6}$/);

    const wrong = waitFor(socket, 'verify-email-result');
    socket.emit('verify-email-code', { code: wrongCode(lastCode()) });
    expect(await wrong).toMatchObject({ ok: false, reason: 'wrong_code', code: 'verify_email_wrong_code', attemptsLeft: 2 });

    const right = waitFor(socket, 'verify-email-result');
    socket.emit('verify-email-code', { code: lastCode() });
    expect(await right).toMatchObject({ ok: true, email, code: 'verify_email_verified' });

    const conversation = await Conversation.findOne({ sessionId });
    const contact = await Contact.findById(conversation.contact);
    expect(contact).toMatchObject({ identityLevel: 'verified', verifiedBy: 'email_code', email });
  });

  it('works before the conversation exists, and the conversation is then the verified person\'s', async () => {
    const { socket, sessionId } = await harness.startVisitor('p2d-verify-early', company.widgetKey);
    const email = address('early');

    const sent = waitFor(socket, 'verify-email-sent');
    socket.emit('verify-email-start', { email });
    await sent;
    const result = waitFor(socket, 'verify-email-result');
    socket.emit('verify-email-code', { code: lastCode() });
    expect((await result).ok).toBe(true);

    harness.say(socket, 'Hello');
    const conversation = await eventually(() => Conversation.findOne({ sessionId, contact: { $exists: true } }));
    expect((await Contact.findById(conversation.contact)).verifiedBy).toBe('email_code');
  });

  it('answers a start it refuses with a reason and a notice code', async () => {
    const { socket } = await harness.startVisitor('p2d-verify-bad', company.widgetKey);
    const result = waitFor(socket, 'verify-email-result');
    socket.emit('verify-email-start', { email: 'nope' });
    expect(await result).toMatchObject({ ok: false, reason: 'invalid_email', stage: 'start', code: 'verify_email_invalid' });
  });

  it('does nothing for a socket with no session of its own', async () => {
    const socket = await harness.connectVisitor(company.widgetKey);
    const result = waitFor(socket, 'verify-email-result');
    socket.emit('verify-email-start', { email: address('unbound'), sessionId: freshSessionId('p2d-stolen') });
    expect(await result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
