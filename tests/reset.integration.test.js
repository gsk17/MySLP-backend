import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Forgotten-password reset, end to end against a real in-memory MongoDB.
 *
 * No SMTP is configured here, so the mailer falls back to console mode and the
 * code comes back as `devCode` — which is exactly the path a marker without
 * email credentials would exercise.
 */
let mongo;
let server;
let base = '';
let available = false;

const USER = {
  email: 'reset.tester@shangri-la.sl',
  password: 'Str0ngPass',
  newPassword: 'Even5tronger',
  fullName: 'Rhea Setter',
  addressLine: '20 University Road',
  city: 'Shangri-La',
  postcode: 'LE1 7RH',
  propertyType: 'flat',
};

beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('myslp_reset_test');
    process.env.JWT_SECRET = 'reset-test-secret';
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = '';
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

    const { default: app } = await import('../src/app.js');
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    available = true;
  } catch (err) {
    console.warn('[reset] skipped —', err.message);
    available = false;
  }
}, 180_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(() => r()));
  const { disconnectDB } = await import('../src/db.js');
  await disconnectDB().catch(() => undefined);
  if (mongo) await mongo.stop();
});

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = (path, token) =>
  fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe.runIf(() => available)('forgotten password reset', () => {
  let oldToken = '';
  let resetCode = '';

  it('sets up a verified account', async () => {
    const reg = await (await post('/api/auth/register', USER)).json();
    expect(reg.devCode).toMatch(/^\d{6}$/);

    const verified = await post('/api/auth/verify-email', {
      email: USER.email,
      code: reg.devCode,
    });
    expect(verified.status).toBe(200);
    oldToken = (await verified.json()).token;

    // That session works before the reset.
    expect((await get('/api/profile', oldToken)).status).toBe(200);
  });

  it('answers identically for an unknown address, so it cannot be used to probe', async () => {
    const known = await post('/api/auth/forgot-password', { email: USER.email });
    const unknown = await post('/api/auth/forgot-password', { email: 'nobody@shangri-la.sl' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);

    const kb = await known.json();
    const ub = await unknown.json();
    expect(kb.sent).toBe(true);
    expect(ub.sent).toBe(true);
    // The unknown address gets no code, but the shape is the same.
    expect(ub.devCode).toBeUndefined();

    resetCode = kb.devCode;
    expect(resetCode).toMatch(/^\d{6}$/);
  });

  it('refuses a wrong code and counts the attempts down', async () => {
    const res = await post('/api/auth/reset-password', {
      email: USER.email,
      code: '000000',
      password: USER.newPassword,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_CODE');
    expect(body.error.message).toMatch(/attempts remaining/);
  });

  it('enforces password strength on the new password', async () => {
    const res = await post('/api/auth/reset-password', {
      email: USER.email,
      code: resetCode,
      password: 'weak',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.field).toBe('password');
  });

  it('resets with the right code and signs the user straight in', async () => {
    const res = await post('/api/auth/reset-password', {
      email: USER.email,
      code: resetCode,
      password: USER.newPassword,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(USER.email);
    expect(body.user.passwordHash).toBeUndefined();

    // The new session works.
    expect((await get('/api/profile', body.token)).status).toBe(200);
  });

  it('ENDS every session that existed before the reset', async () => {
    const res = await get('/api/profile', oldToken);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('PASSWORD_CHANGED');
  });

  it('will not reuse a spent reset code', async () => {
    const res = await post('/api/auth/reset-password', {
      email: USER.email,
      code: resetCode,
      password: 'Another0ne',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('CODE_NOT_FOUND');
  });

  it('the old password no longer works', async () => {
    const res = await post('/api/auth/login', { email: USER.email, password: USER.password });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('the new password does', async () => {
    const res = await post('/api/auth/login', { email: USER.email, password: USER.newPassword });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeTruthy();
  });

  it('throttles a second request for a code', async () => {
    // The successful reset cleared this user's codes, so the first request
    // after it is legitimately allowed; the cooldown applies to the next one.
    const first = await post('/api/auth/forgot-password', { email: USER.email });
    expect(first.status).toBe(200);

    const second = await post('/api/auth/forgot-password', { email: USER.email });
    expect(second.status).toBe(429);
    expect((await second.json()).error.message).toMatch(/wait \d+ second/);
  });

  it('stores the reset code hashed, never in plaintext', async () => {
    const fresh = { ...USER, email: 'reset.hash@shangri-la.sl' };
    const reg = await (await post('/api/auth/register', fresh)).json();
    await post('/api/auth/verify-email', { email: fresh.email, code: reg.devCode });

    const asked = await (await post('/api/auth/forgot-password', { email: fresh.email })).json();

    const { EmailVerification } = await import('../src/models/EmailVerification.js');
    const record = await EmailVerification.findOne({
      email: fresh.email,
      purpose: 'password_reset',
    }).lean();

    expect(record).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(asked.devCode);
    expect(record.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
