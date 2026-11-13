import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * The rate limiter, against a real MongoDB.
 *
 * The point of these is the thing the old in-memory limiter could not do:
 * two SEPARATE app instances — standing in for two serverless instances —
 * must share one counter. A per-process counter passes every other test in
 * this file and still fails that one.
 */
let mongo;
let serverA;
let instanceB;
let baseA = '';
let baseB = '';
let available = false;

beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('myslp_ratelimit_test');
    process.env.JWT_SECRET = 'ratelimit-test-secret';
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = '';

    const { connectDB } = await import('../src/db.js');
    await connectDB(process.env.MONGODB_URI);

    const { default: appA } = await import('../src/app.js');
    await new Promise((r) => {
      serverA = appA.listen(0, () => r());
    });
    baseA = `http://127.0.0.1:${serverA.address().port}`;

    /*
     * Instance B runs as its own PROCESS, sharing only the database.
     *
     * Importing the app twice in one process does not work: Node gives
     * `../src/app.js?x=1` a fresh module, but its dependencies keep their
     * original specifiers and are reused, so the limiter closure — and its
     * Map — would still be shared, and this file could not tell a per-process
     * counter from a shared one.
     */
    const helper = fileURLToPath(new URL('./helpers/instance.mjs', import.meta.url));
    instanceB = spawn(process.execPath, [helper], {
      env: { ...process.env, MONGODB_URI: process.env.MONGODB_URI },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('instance B did not start')), 30_000);
      instanceB.stdout.on('data', (chunk) => {
        const m = /PORT=(\d+)/.exec(String(chunk));
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      instanceB.stderr.on('data', (c) => console.warn('[instance B]', String(c).trim()));
    });
    baseB = `http://127.0.0.1:${port}`;
    available = true;
  } catch (err) {
    console.warn('[ratelimit] skipped —', err.message);
    available = false;
  }
}, 180_000);

afterAll(async () => {
  if (instanceB) instanceB.kill();
  if (serverA) await new Promise((r) => serverA.close(() => r()));
  const { disconnectDB } = await import('../src/db.js');
  await disconnectDB().catch(() => undefined);
  if (mongo) await mongo.stop();
});

const login = (base, email) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'NotTheRightOne1' }),
  });

describe.runIf(() => available)('rate limiting', () => {
  it('reports the remaining allowance on every response', async () => {
    const res = await login(baseA, 'counter@shangri-la.sl');
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(Number(res.headers.get('x-ratelimit-remaining'))).toBe(9);
    expect(Number(res.headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000);
  });

  it('counts down across requests and then refuses', async () => {
    // One already spent above; nine more reach the limit of ten.
    for (let i = 0; i < 9; i += 1) {
      const res = await login(baseA, 'counter@shangri-la.sl');
      expect(res.status).toBe(401); // wrong password, but allowed through
    }
    const blocked = await login(baseA, 'counter@shangri-la.sl');
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('SHARES the count between separate processes', async () => {
    // The whole reason for moving the counter into the database: instance B
    // is a different process with its own memory and has served no requests,
    // but the caller is already over the limit and must still be refused.
    const fromOtherInstance = await login(baseB, 'counter@shangri-la.sl');
    expect(fromOtherInstance.status).toBe(429);
  });

  it('keeps one window per endpoint', async () => {
    // Sign-in is exhausted, but a different route has its own allowance.
    const res = await fetch(`${baseA}/rest/council_tax_check?postcode=LE1%207RH`);
    expect(res.status).not.toBe(429);
  });

  it('starts a fresh window once the old one expires', async () => {
    const { RateLimit } = await import('../src/models/RateLimit.js');
    const doc = await RateLimit.findOne({ _id: /login/ });
    expect(doc).toBeTruthy();
    expect(doc.count).toBeGreaterThan(10);

    // Wind the window back rather than waiting fifteen minutes for it.
    await RateLimit.updateOne({ _id: doc._id }, { $set: { resetAt: new Date(Date.now() - 1000) } });

    const res = await login(baseA, 'counter@shangri-la.sl');
    expect(res.status).toBe(401);
    expect(Number(res.headers.get('x-ratelimit-remaining'))).toBe(9);
  });

  it('lets requests through when the database is unreachable', async () => {
    // A limiter that cannot count must not be able to take sign-in down with
    // it, so the check fails open.
    const mongoose = (await import('mongoose')).default;
    const readyState = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, 'readyState', {
      value: 0,
      configurable: true,
    });
    try {
      const res = await login(baseA, 'counter@shangri-la.sl');
      expect(res.status).not.toBe(429);
    } finally {
      Object.defineProperty(mongoose.connection, 'readyState', {
        value: readyState,
        configurable: true,
      });
    }
  });
});
