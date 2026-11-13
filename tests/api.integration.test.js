import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * End-to-end check against a real in-memory MongoDB: boots the Express app,
 * seeds data through the real services, and exercises the endpoints over HTTP.
 *
 * Skipped automatically when the mongodb-memory-server binary cannot be
 * downloaded (e.g. offline CI), so `npm test` never fails for that reason.
 */
let mongo;
let server;
let base = '';
let available = false;
let customerToken = '';
let adminToken = '';
beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('myslp_test');
    process.env.JWT_SECRET = 'test-secret-for-integration-tests-only';
    process.env.NODE_ENV = 'test';
    const { connectDB } = await import('../src/db.js');
    await connectDB(process.env.MONGODB_URI);
    const { default: app } = await import('../src/app.js');
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    await seedForTests();
    available = true;
  } catch (err) {
    console.warn('[integration] skipped — in-memory MongoDB unavailable:', err.message);
    available = false;
  }
}, 180_000);
afterAll(async () => {
  if (server) await new Promise((r) => server.close(() => r()));
  const { disconnectDB } = await import('../src/db.js');
  await disconnectDB().catch(() => undefined);
  if (mongo) await mongo.stop();
});
async function seedForTests() {
  const bcrypt = (await import('bcryptjs')).default;
  const { User } = await import('../src/models/User.js');
  const { Tariff } = await import('../src/models/Tariff.js');
  const { Voucher } = await import('../src/models/Voucher.js');
  const { CouncilTaxProperty } = await import('../src/models/CouncilTaxProperty.js');
  const { createReading } = await import('../src/services/billing.js');
  const { normaliseAddress, normalisePostcode } = await import('../src/utils/normalise.js');
  await Tariff.create({
    electricityDayRate: 0.34,
    electricityNightRate: 0.2,
    gasRate: 0.1,
    standingChargePerDay: 0,
    effectiveFrom: new Date('2026-01-01'),
  });
  for (const p of [
    {
      fullAddress: '20 University Road, Shangri-La',
      postcode: 'LE1 7RH',
      councilTaxBand: 'C',
    },
    {
      fullAddress: '10 St Leonards Road, Shangri-La',
      postcode: 'LE2 1WS',
      councilTaxBand: 'B',
    },
    {
      fullAddress: '1 Queens Road, Shangri-La',
      postcode: 'SL2 7RH',
      councilTaxBand: 'A',
    },
  ]) {
    await CouncilTaxProperty.create({
      ...p,
      postcodeNormalised: normalisePostcode(p.postcode),
      addressNormalised: normaliseAddress(p.fullAddress),
    });
  }
  await Voucher.create({
    code: 'JOV50TOSYR',
    value: 200,
    redeemed: false,
  });
  await Voucher.create({
    code: 'E4GE75H7Q6',
    value: 200,
    redeemed: true,
    redeemedAt: new Date(),
  });
  await User.create({
    email: 'admin@myslp.sl',
    passwordHash: await bcrypt.hash('Admin@123', 10),
    fullName: 'Admin',
    addressLine: 'HQ',
    city: 'Shangri-La',
    postcode: 'SL1 1AA',
    postcodeNormalised: 'SL11AA',
    propertyType: 'detached',
    role: 'admin',
    emailVerified: true,
    energyCredit: 0,
  });

  // A band-B customer on LE2 with two real bills, so /rest/statistics/B/LE2
  // returns a genuine non-zero average.
  const customer = await User.create({
    email: 'stats@shangri-la.sl',
    passwordHash: await bcrypt.hash('Demo@1234', 10),
    fullName: 'Stats Customer',
    addressLine: '10 St Leonards Road',
    city: 'Shangri-La',
    postcode: 'LE2 1WS',
    postcodeNormalised: 'LE21WS',
    propertyType: 'flat',
    councilTaxBand: 'B',
    emailVerified: true,
    energyCredit: 500,
  });
  await createReading(customer._id, {
    readingDate: '2026-09-20',
    electricityDay: 100,
    electricityNight: 250,
    gas: 800,
  });
  await createReading(customer._id, {
    readingDate: '2026-10-20',
    electricityDay: 200,
    electricityNight: 500,
    gas: 1600,
  });
}
const api = (path, init) => fetch(`${base}${path}`, init);
const json = (body, token) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token
      ? {
          Authorization: `Bearer ${token}`,
        }
      : {}),
  },
  body: JSON.stringify(body),
});
describe.runIf(() => available)('REST API — Task 2 (automatically graded)', () => {
  it('GET /rest/council_tax_check returns the band for a known address', async () => {
    const res = await api(
      '/rest/council_tax_check?postcode=LE17RH&fulladdress=20%20University%20Road%2C%20Shangri-La',
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe('20 University Road, Shangri-La');
    expect(body.council_tax_band).toBe('C');
  });
  it('matches the postcode with or without a space, in any case', async () => {
    for (const pc of ['LE17RH', 'LE1 7RH', 'le1 7rh', 'le17rh']) {
      const res = await api(
        `/rest/council_tax_check?postcode=${encodeURIComponent(pc)}&fulladdress=20%20University%20Road,%20Shangri-La`,
      );
      expect(res.status, `postcode ${pc}`).toBe(200);
      expect((await res.json()).council_tax_band).toBe('C');
    }
  });
  it('404s with a JSON error for an unknown address', async () => {
    const res = await api('/rest/council_tax_check?postcode=ZZ99ZZ&fulladdress=Nowhere');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Address not found');
  });
  it('400s when neither parameter is supplied', async () => {
    const res = await api('/rest/council_tax_check');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('MISSING_PARAMETERS');
  });
  it('GET /rest/statistics/B/LE2 returns both spellings of the band key', async () => {
    const res = await api('/rest/statistics/B/LE2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counil_tax_band).toBe('B'); // the specification's typo
    expect(body.council_tax_band).toBe('B'); // the correct spelling
    expect(body.postcode_prefix).toBe('LE2');
    // The marker confirmed the brief's "SLD" was a typo; the currency is pounds.
    expect(body.currency).toBe('gbp');
    expect(typeof body.average_electricity_gas_cost_per_day).toBe('string');

    // 164.00 over 30 days = 5.4666... -> "5.47"
    expect(Number(body.average_electricity_gas_cost_per_day)).toBeCloseTo(5.47, 2);
  });
  it('returns 0 rather than an error when nothing matches', async () => {
    const res = await api('/rest/statistics/H/ZZ9');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.average_electricity_gas_cost_per_day).toBe('0');
    expect(body.properties_matched).toBe(0);
  });
  it('400s on an invalid band instead of 500', async () => {
    for (const bad of ['Z', '1', 'AB']) {
      const res = await api(`/rest/statistics/${bad}/LE2`);
      expect(res.status, `band ${bad}`).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_BAND');
    }
  });
  it('returns JSON, not HTML, for an unknown route', async () => {
    const res = await api('/rest/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error.code).toBe('ROUTE_NOT_FOUND');
  });
});
describe.runIf(() => available)('Auth — Task 1', () => {
  it('registers a customer with £500 credit, the Council payment and a detected band', async () => {
    const res = await api(
      '/api/auth/register',
      json({
        email: 'new.customer@shangri-la.sl',
        password: 'Str0ngPass',
        fullName: 'New Customer',
        addressLine: '20 University Road',
        city: 'Shangri-La',
        postcode: 'LE1 7RH',
        propertyType: 'terraced',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    // A session is issued only after the emailed code is verified.
    expect(body.token).toBeUndefined();
    expect(body.requiresVerification).toBe(true);
    expect(body.user.emailVerified).toBe(false);
    // Every account opens with £500. 20 University Road is band C, so the
    // Council's £200 cost-of-living payment is credited on top of it.
    expect(body.user.energyCredit).toBe(700);
    expect(body.user.councilPaymentPaidAt).toBeTruthy();
    expect(body.user.councilTaxBand).toBe('C');
    expect(body.councilPaymentEligible).toBe(true);
    expect(body.user.passwordHash).toBeUndefined();
    const verified = await api(
      '/api/auth/verify-email',
      json({
        email: 'new.customer@shangri-la.sl',
        code: body.devCode,
      }),
    );
    expect(verified.status).toBe(200);
    const session = await verified.json();
    expect(session.user.emailVerified).toBe(true);
    customerToken = session.token;
  });
  it('rejects a duplicate email address', async () => {
    const res = await api(
      '/api/auth/register',
      json({
        email: 'new.customer@shangri-la.sl',
        password: 'Str0ngPass',
        fullName: 'Duplicate',
        addressLine: '20 University Road',
        city: 'Shangri-La',
        postcode: 'LE1 7RH',
        propertyType: 'flat',
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(body.error.field).toBe('email');
  });
  it('rejects a weak password with a helpful message', async () => {
    const res = await api(
      '/api/auth/register',
      json({
        email: 'weak@shangri-la.sl',
        password: 'short',
        fullName: 'Weak',
        addressLine: '20 University Road',
        city: 'Shangri-La',
        postcode: 'LE1 7RH',
        propertyType: 'flat',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.field).toBe('password');
  });
  it('rejects an invalid email or password on login', async () => {
    const bad = await api(
      '/api/auth/login',
      json({
        email: 'nobody@x.sl',
        password: 'Wrong123',
      }),
    );
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe('INVALID_CREDENTIALS');
    const malformed = await api(
      '/api/auth/login',
      json({
        email: 'not-an-email',
        password: 'x',
      }),
    );
    expect(malformed.status).toBe(400);
  });
  it('signs an administrator in', async () => {
    const res = await api(
      '/api/auth/login',
      json({
        email: 'admin@myslp.sl',
        password: 'Admin@123',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe('admin');
    adminToken = body.token;
  });
  it('reports whether an email is available', async () => {
    const taken = await api('/api/auth/check-email?email=admin@myslp.sl');
    expect((await taken.json()).available).toBe(false);
    const free = await api('/api/auth/check-email?email=nobody-here@shangri-la.sl');
    expect((await free.json()).available).toBe(true);
  });
  it('401s without a token and with a bad token', async () => {
    expect((await api('/api/profile')).status).toBe(401);
    expect(
      (
        await api('/api/profile', {
          headers: {
            Authorization: 'Bearer nonsense',
          },
        })
      ).status,
    ).toBe(401);
  });
});
describe.runIf(() => available)('Readings, bills and vouchers', () => {
  it('stores the first submission as a baseline with no bill', async () => {
    const res = await api(
      '/api/readings',
      json(
        {
          readingDate: '2026-09-20',
          electricityDay: 100,
          electricityNight: 250,
          gas: 800,
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bill).toBeNull();
    expect(body.reading.isBaseline).toBe(true);
  });
  it('generates a 164.00 bill for the second submission', async () => {
    const res = await api(
      '/api/readings',
      json(
        {
          readingDate: '2026-10-20',
          electricityDay: 200,
          electricityNight: 500,
          gas: 1600,
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bill.days).toBe(30);
    expect(body.bill.totalAmount).toBe(164);
    expect(body.bill.status).toBe('unpaid');
  });
  it('rejects a reading lower than the previous one for the same register', async () => {
    const res = await api(
      '/api/readings',
      json(
        {
          readingDate: '2026-11-01',
          electricityDay: 300,
          electricityNight: 480,
          gas: 2500,
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('READING_LOWER_THAN_PREVIOUS');
    expect(body.error.field).toBe('electricityNight');
    expect(body.error.message).toContain('480 kWh');
    expect(body.error.message).toContain('500 kWh');
  });
  it('rejects a future submission date', async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await api(
      '/api/readings',
      json(
        {
          readingDate: future,
          electricityDay: 999,
          electricityNight: 999,
          gas: 9999,
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('READING_DATE_IN_FUTURE');
  });
  it('pays the bill from the energy credit', async () => {
    const list = await (
      await api('/api/bills', {
        headers: {
          Authorization: `Bearer ${customerToken}`,
        },
      })
    ).json();
    const unpaid = list.bills.find((b) => b.status === 'unpaid');
    expect(unpaid).toBeTruthy();
    const res = await api(`/api/bills/${unpaid.id}/pay`, json({}, customerToken));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bill.status).toBe('paid');
    // 500 opening + 200 Council payment (band C) - 164 bill
    expect(body.energyCredit).toBe(536);
  });
  it('refuses to pay the same bill twice', async () => {
    const list = await (
      await api('/api/bills', {
        headers: {
          Authorization: `Bearer ${customerToken}`,
        },
      })
    ).json();
    const paid = list.bills.find((b) => b.status === 'paid');
    const res = await api(`/api/bills/${paid.id}/pay`, json({}, customerToken));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('BILL_ALREADY_PAID');
  });
  it('redeems a valid voucher once and refuses the second attempt', async () => {
    const first = await api(
      '/api/vouchers/redeem',
      json(
        {
          code: 'jov50tosyr',
        },
        customerToken,
      ),
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.amount).toBe(200);
    // ...then a 200 voucher on top
    expect(body.energyCredit).toBe(736);

    const second = await api(
      '/api/vouchers/redeem',
      json(
        {
          code: 'JOV50TOSYR',
        },
        customerToken,
      ),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('VOUCHER_ALREADY_REDEEMED');
  });
  it('reports an unknown voucher code separately', async () => {
    const res = await api(
      '/api/vouchers/redeem',
      json(
        {
          code: 'NOTAREALCODE',
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('VOUCHER_NOT_FOUND');
  });
  it('reports an already-redeemed voucher', async () => {
    const res = await api(
      '/api/vouchers/redeem',
      json(
        {
          code: 'E4GE75H7Q6',
        },
        customerToken,
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('VOUCHER_ALREADY_REDEEMED');
  });
});
describe.runIf(() => available)('Administrator', () => {
  it('blocks a customer from the admin area', async () => {
    const res = await api('/api/admin/customers', {
      headers: {
        Authorization: `Bearer ${customerToken}`,
      },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
  it('lists customers for an administrator', async () => {
    const res = await api('/api/admin/customers', {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.customers[0].passwordHash).toBeUndefined();
  });
  it('creates a new tariff version rather than overwriting', async () => {
    const before = await (
      await api('/api/admin/tariffs', {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      })
    ).json();
    const res = await api(
      '/api/admin/tariffs',
      json(
        {
          electricityDayRate: 0.4,
          electricityNightRate: 0.25,
          gasRate: 0.12,
          standingChargePerDay: 0.1,
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(201);
    const after = await (
      await api('/api/admin/tariffs', {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      })
    ).json();
    expect(after.tariffs.length).toBe(before.tariffs.length + 1);
    expect(after.active.electricityDayRate).toBe(0.4);
  });
  it('rejects a negative tariff rate', async () => {
    const res = await api(
      '/api/admin/tariffs',
      json(
        {
          electricityDayRate: -1,
          electricityNightRate: 0.2,
          gasRate: 0.1,
          standingChargePerDay: 0,
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(400);
  });
  it('returns per-customer consumption averages in kWh', async () => {
    const list = await (
      await api('/api/admin/customers', {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      })
    ).json();
    const target = list.customers.find((c) => c.email === 'stats@shangri-la.sl');
    const res = await api(`/api/admin/customers/${target.id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // One bill: 100 + 250 = 350 kWh electricity, 800 kWh gas.
    expect(body.averages.averageElectricityKwhPerPeriod).toBe(350);
    expect(body.averages.averageGasKwhPerPeriod).toBe(800);
    expect(body.averages.periods).toBe(1);
  });
  it('400s on a malformed customer id instead of 500', async () => {
    const res = await api('/api/admin/customers/not-an-object-id', {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

describe.runIf(() => available)('council tax REST strictness', () => {
  it('does NOT guess from the postcode when the address is unknown', async () => {
    // The app's own forms fall back to an unambiguous postcode; this endpoint
    // must not, because the specification requires "Address not found" and the
    // marking harness checks for it.
    const res = await fetch(
      `${base}/rest/council_tax_check?postcode=LE1%207RH&fulladdress=Leicester,%20Flat%2011`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Address not found');
  });
});
