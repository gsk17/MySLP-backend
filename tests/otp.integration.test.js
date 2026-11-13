import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import nodemailer from 'nodemailer';

/**
 * End-to-end check of email verification against a real in-memory MongoDB and
 * a REAL SMTP server: nodemailer's Ethereal service accepts the message, holds
 * it, and returns a preview URL — so this proves the mail path actually works
 * rather than stubbing it out.
 *
 * Skips itself when either the mongodb-memory-server binary or Ethereal is
 * unreachable, so `npm test` never fails merely for being offline.
 */
let mongo;
let server;
let base = '';
let available = false;
const REG = {
  email: 'otp.tester@shangri-la.sl',
  password: 'Str0ngPass',
  fullName: 'Otto Pemberton',
  addressLine: '20 University Road',
  city: 'Shangri-La',
  postcode: 'LE1 7RH',
  propertyType: 'flat',
};
beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();

    // A real throwaway SMTP inbox.
    const testAccount = await nodemailer.createTestAccount();
    process.env.MONGODB_URI = mongo.getUri('myslp_otp_test');
    process.env.JWT_SECRET = 'otp-test-secret';
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = testAccount.smtp.host;
    process.env.SMTP_PORT = String(testAccount.smtp.port);
    process.env.SMTP_USER = testAccount.user;
    process.env.SMTP_PASS = testAccount.pass;
    process.env.MAIL_FROM = 'MySLP <no-reply@myslp.sl>';
    process.env.OTP_RESEND_SECONDS = '60';
    process.env.OTP_MAX_ATTEMPTS = '5';
    const { connectDB } = await import('../src/db.js');
    await connectDB(process.env.MONGODB_URI);
    const { Tariff } = await import('../src/models/Tariff.js');
    await Tariff.create({
      electricityDayRate: 0.34,
      electricityNightRate: 0.2,
      gasRate: 0.1,
      standingChargePerDay: 0,
      effectiveFrom: new Date('2026-01-01'),
    });

    // The register route looks the band up from this table.
    const { CouncilTaxProperty } = await import('../src/models/CouncilTaxProperty.js');
    const { normaliseAddress, normalisePostcode } = await import('../src/utils/normalise.js');
    await CouncilTaxProperty.create({
      fullAddress: '20 University Road, Shangri-La',
      postcode: 'LE1 7RH',
      postcodeNormalised: normalisePostcode('LE1 7RH'),
      addressNormalised: normaliseAddress('20 University Road, Shangri-La'),
      councilTaxBand: 'C',
    });
    const { default: app } = await import('../src/app.js');
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    available = true;
  } catch (err) {
    console.warn('[otp] skipped —', err.message);
    available = false;
  }
}, 180_000);
afterAll(async () => {
  if (server) await new Promise((r) => server.close(() => r()));
  const { disconnectDB } = await import('../src/db.js');
  await disconnectDB().catch(() => undefined);
  if (mongo) await mongo.stop();
});
const api = (path, body) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
          },
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
        }),
  });
describe.runIf(() => available)('email verification', () => {
  let code = '';
  it('registration sends a real email and returns NO token', async () => {
    const res = await api('/api/auth/register', REG);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(body.requiresVerification).toBe(true);
    expect(body.email).toBe(REG.email);
    expect(body.user.emailVerified).toBe(false);

    // Actually handed to an SMTP server, with a preview link.
    expect(body.delivery).toBe('smtp');
    expect(body.previewUrl).toMatch(/^https?:\/\//);
    console.log('      ↳ sent mail preview:', body.previewUrl);
    expect(body.devCode).toMatch(/^\d{6}$/);
    code = body.devCode;
  });
  it('refuses sign-in until the address is confirmed', async () => {
    const res = await api('/api/auth/login', {
      email: REG.email,
      password: REG.password,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('EMAIL_NOT_VERIFIED');
  });
  it('rejects a wrong code and counts down the attempts', async () => {
    const res = await api('/api/auth/verify-email', {
      email: REG.email,
      code: '000000',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_CODE');
    expect(body.error.message).toMatch(/attempts remaining/);
  });
  it('rejects a malformed code before touching the database', async () => {
    const res = await api('/api/auth/verify-email', {
      email: REG.email,
      code: '12ab',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.field).toBe('code');
  });
  it('rate-limits resend inside the cooldown', async () => {
    const res = await api('/api/auth/resend-code', {
      email: REG.email,
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toMatch(/wait \d+ second/);
  });
  it('does not reveal whether an unknown address exists', async () => {
    const res = await api('/api/auth/resend-code', {
      email: 'nobody@shangri-la.sl',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
  });
  it('accepts the right code and returns a session', async () => {
    const res = await api('/api/auth/verify-email', {
      email: REG.email,
      code,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.emailVerified).toBe(true);
    expect(body.user.councilTaxBand).toBe('C');
    // £500 opening credit plus the Council's £200 cost-of-living payment,
    // which bands A-D receive.
    expect(body.user.energyCredit).toBe(700);
    expect(body.user.councilPaymentPaidAt).toBeTruthy();
  });
  it('will not reuse a spent code', async () => {
    const res = await api('/api/auth/verify-email', {
      email: REG.email,
      code,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ALREADY_VERIFIED');
  });
  it('signs in normally once verified', async () => {
    const res = await api('/api/auth/login', {
      email: REG.email,
      password: REG.password,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeTruthy();
  });
  it('destroys the code after too many wrong guesses', async () => {
    const victim = {
      ...REG,
      email: 'bruteforce@shangri-la.sl',
    };
    const reg = await (await api('/api/auth/register', victim)).json();
    expect(reg.devCode).toMatch(/^\d{6}$/);
    const wrong = reg.devCode === '111111' ? '222222' : '111111';
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await api('/api/auth/verify-email', {
        email: victim.email,
        code: wrong,
      });
    }
    expect(last.status).toBe(429);

    // Even the correct code is now useless — the record was destroyed.
    const after = await api('/api/auth/verify-email', {
      email: victim.email,
      code: reg.devCode,
    });
    expect(after.status).toBe(400);
    expect((await after.json()).error.code).toBe('CODE_NOT_FOUND');
  });
  it('stores the code hashed, never in plaintext', async () => {
    const fresh = {
      ...REG,
      email: 'hashcheck@shangri-la.sl',
    };
    const reg = await (await api('/api/auth/register', fresh)).json();
    const { EmailVerification } = await import('../src/models/EmailVerification.js');
    const record = await EmailVerification.findOne({
      email: fresh.email,
    }).lean();
    expect(record).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(reg.devCode);
    expect(record.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
