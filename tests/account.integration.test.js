import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Account self-service, end to end against a real in-memory MongoDB:
 * address and property type, change of email address, change of password,
 * notification preferences, the in-app notification feed, data export and
 * account deletion.
 *
 * No SMTP is configured, so the mailer falls back to console mode and codes
 * come back as `devCode` — the same path a marker without email credentials
 * would take.
 */
let mongo;
let server;
let base = '';
let available = false;

const USER = {
  email: 'account.tester@shangri-la.sl',
  password: 'Str0ngPass',
  fullName: 'Ama Dablam',
  addressLine: '20 University Road',
  city: 'Shangri-La',
  postcode: 'LE1 7RH',
  propertyType: 'flat',
};

let token = '';

beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('myslp_account_test');
    process.env.JWT_SECRET = 'account-test-secret';
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = '';
    process.env.OTP_RESEND_SECONDS = '0';

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

    // The council tax register, so the address lookup has something to match.
    const { CouncilTaxProperty } = await import('../src/models/CouncilTaxProperty.js');
    const { COUNCIL_TAX_PROPERTIES } = await import('../src/data/councilTaxProperties.js');
    const { normalisePostcode, normaliseAddress } = await import('../src/utils/normalise.js');
    await CouncilTaxProperty.insertMany(
      COUNCIL_TAX_PROPERTIES.map((p) => ({
        ...p,
        postcodeNormalised: normalisePostcode(p.postcode),
        addressNormalised: normaliseAddress(p.fullAddress),
      })),
    );

    const { default: app } = await import('../src/app.js');
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const reg = await (
      await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(USER),
      })
    ).json();
    const verified = await (
      await fetch(`${base}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: USER.email, code: reg.devCode }),
      })
    ).json();
    token = verified.token;
    available = true;
  } catch (err) {
    console.warn('[account] skipped —', err.message);
    available = false;
  }
}, 180_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(() => r()));
  const { disconnectDB } = await import('../src/db.js');
  await disconnectDB().catch(() => undefined);
  if (mongo) await mongo.stop();
});

const call = (method, path, body, tok = token) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe.runIf(() => available)('account self-service', () => {
  describe('address and property type', () => {
    it('re-resolves the council tax band when the address changes', async () => {
      // 20 University Road is band C; 29 Stoneygate Road is band F.
      const res = await call('PATCH', '/api/profile', {
        addressLine: '29 Stoneygate Road',
        city: 'Shangri-La',
        postcode: 'LE2 2AF',
        propertyType: 'detached',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.profile.councilTaxBand).toBe('F');
      expect(body.profile.propertyType).toBe('detached');
      expect(body.bandChanged).toBe(true);
    });

    it('clears the band when the new address is not on the register', async () => {
      const res = await call('PATCH', '/api/profile', {
        addressLine: '99 Nowhere Street',
        city: 'Shangri-La',
        postcode: 'ZZ9 9ZZ',
        propertyType: 'flat',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The stale band must not survive a move to an unknown address.
      expect(body.profile.councilTaxBand).toBeNull();
      expect(body.message).toMatch(/could not match/i);
    });

    it('rejects an invalid property type with a field-level message', async () => {
      const res = await call('PATCH', '/api/profile', {
        addressLine: '20 University Road',
        city: 'Shangri-La',
        postcode: 'LE1 7RH',
        propertyType: 'castle',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.field).toBe('propertyType');
    });

    it('matches on an unambiguous postcode when the street is not registered', async () => {
      // A real postcode with a flat number and an unregistered town. LE1 7RH
      // identifies exactly one property, so the app should still find it.
      const res = await call('PATCH', '/api/profile', {
        addressLine: 'Leicester, Flat 11',
        city: 'Shangri-La',
        postcode: 'LE1 7RH',
        propertyType: 'flat',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).profile.councilTaxBand).toBe('C');
    });

    it('still refuses when the postcode covers more than one property', async () => {
      // SL2 7RH holds both 1 Queens Road (A) and 32 Welford Road (D), so
      // guessing from the postcode alone would be a coin toss.
      const res = await call('PATCH', '/api/profile', {
        addressLine: 'Some Unregistered Street',
        city: 'Shangri-La',
        postcode: 'SL2 7RH',
        propertyType: 'flat',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).profile.councilTaxBand).toBeNull();
    });

    it('restores a known address and its band', async () => {
      const res = await call('PATCH', '/api/profile', {
        addressLine: USER.addressLine,
        city: USER.city,
        postcode: USER.postcode,
        propertyType: USER.propertyType,
      });
      expect((await res.json()).profile.councilTaxBand).toBe('C');
    });
  });

  describe('the Council cost-of-living payment', () => {
    it('was credited at registration, on top of the £500', async () => {
      // This account registered at 20 University Road — band C, so bands A-D
      // applies and £200 should already be on the balance.
      const { profile } = await (await call('GET', '/api/profile')).json();
      expect(profile.councilPaymentPaidAt).toBeTruthy();

      const { payments } = await (await call('GET', '/api/payments')).json();
      const council = payments.filter((p) => p.type === 'council_payment');
      expect(council).toHaveLength(1);
      expect(council[0].amount).toBe(200);
    });

    it('is not paid twice when the address changes within bands A-D', async () => {
      // 29 Stoneygate Road is band F, 20 University Road is band C. Moving
      // out and back must not trigger a second payment.
      await call('PATCH', '/api/profile', {
        addressLine: '29 Stoneygate Road',
        city: 'Shangri-La',
        postcode: 'LE2 2AF',
        propertyType: 'detached',
      });
      const back = await call('PATCH', '/api/profile', {
        addressLine: USER.addressLine,
        city: USER.city,
        postcode: USER.postcode,
        propertyType: USER.propertyType,
      });
      expect((await back.json()).councilPaymentAwarded).toBe(0);

      const { payments } = await (await call('GET', '/api/payments')).json();
      expect(payments.filter((p) => p.type === 'council_payment')).toHaveLength(1);
    });

    it('is not clawed back when the band stops qualifying', async () => {
      const before = (await (await call('GET', '/api/profile')).json()).profile.energyCredit;
      await call('PATCH', '/api/profile', {
        addressLine: '1 Himalaya Heights',
        city: 'Shangri-La',
        postcode: 'SL1 9AA',
        propertyType: 'mansion',
      });
      const after = await (await call('GET', '/api/profile')).json();
      expect(after.profile.councilTaxBand).toBe('H');
      // The money already paid is not taken back.
      expect(after.profile.energyCredit).toBe(before);
    });

    it('pays an account that only becomes eligible later', async () => {
      // Registers at band H, so no payment; then moves into band C.
      const late = {
        ...USER,
        email: 'late.eligible@shangri-la.sl',
        addressLine: '1 Himalaya Heights',
        postcode: 'SL1 9AA',
        propertyType: 'mansion',
      };
      const reg = await (await call('POST', '/api/auth/register', late)).json();
      const verified = await (
        await call('POST', '/api/auth/verify-email', { email: late.email, code: reg.devCode })
      ).json();
      const tok = verified.token;

      const start = await (await call('GET', '/api/profile', undefined, tok)).json();
      expect(start.profile.councilTaxBand).toBe('H');
      expect(start.profile.councilPaymentPaidAt).toBeNull();
      expect(start.profile.energyCredit).toBe(500);

      const moved = await call(
        'PATCH',
        '/api/profile',
        {
          addressLine: '20 University Road',
          city: 'Shangri-La',
          postcode: 'LE1 7RH',
          propertyType: 'flat',
        },
        tok,
      );
      const body = await moved.json();
      expect(body.councilPaymentAwarded).toBe(200);
      expect(body.profile.energyCredit).toBe(700);
      expect(body.message).toMatch(/Council payment/);
    });

    it('records it as a notification', async () => {
      await new Promise((r) => setTimeout(r, 400));
      const feed = await (await call('GET', '/api/notifications')).json();
      const council = feed.notifications.find((n) => n.type === 'council_payment');
      expect(council).toBeTruthy();
      expect(council.title).toMatch(/£200\.00/);
    });

    it('restores the test account to its registered address', async () => {
      const res = await call('PATCH', '/api/profile', {
        addressLine: USER.addressLine,
        city: USER.city,
        postcode: USER.postcode,
        propertyType: USER.propertyType,
      });
      expect((await res.json()).profile.councilTaxBand).toBe('C');
    });
  });

  describe('changing the email address', () => {
    const NEW_EMAIL = 'ama.moved@shangri-la.sl';

    it('refuses without the current password', async () => {
      const res = await call('POST', '/api/profile/email', {
        email: NEW_EMAIL,
        password: 'WrongPass1',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_PASSWORD');
    });

    it('refuses an address already registered to someone else', async () => {
      const other = { ...USER, email: 'someone.else@shangri-la.sl' };
      await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(other),
      });
      const res = await call('POST', '/api/profile/email', {
        email: other.email,
        password: USER.password,
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('sends a code to the NEW address and changes it on the right code', async () => {
      const asked = await (
        await call('POST', '/api/profile/email', { email: NEW_EMAIL, password: USER.password })
      ).json();
      expect(asked.pendingEmail).toBe(NEW_EMAIL);
      expect(asked.devCode).toMatch(/^\d{6}$/);

      // The code is stored against the new address, not the current one.
      const { EmailVerification } = await import('../src/models/EmailVerification.js');
      const record = await EmailVerification.findOne({ purpose: 'email_change' }).lean();
      expect(record.email).toBe(NEW_EMAIL);
      expect(JSON.stringify(record)).not.toContain(asked.devCode);

      const wrong = await call('POST', '/api/profile/email/verify', { code: '000000' });
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error.code).toBe('INVALID_CODE');

      const ok = await call('POST', '/api/profile/email/verify', { code: asked.devCode });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.profile.email).toBe(NEW_EMAIL);
      expect(body.token).toBeTruthy();
      token = body.token;
    });

    it('signs in with the new address, and not the old one', async () => {
      const old = await call('POST', '/api/auth/login', {
        email: USER.email,
        password: USER.password,
      });
      expect(old.status).toBe(401);

      const fresh = await call('POST', '/api/auth/login', {
        email: NEW_EMAIL,
        password: USER.password,
      });
      expect(fresh.status).toBe(200);
      token = (await fresh.json()).token;
    });
  });

  describe('changing the password', () => {
    const NEW_PASSWORD = 'Even5tronger';

    it('refuses the wrong current password', async () => {
      const res = await call('POST', '/api/profile/password', {
        currentPassword: 'NotIt123',
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.field).toBe('currentPassword');
    });

    it('refuses reusing the same password', async () => {
      const res = await call('POST', '/api/profile/password', {
        currentPassword: USER.password,
        newPassword: USER.password,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('SAME_PASSWORD');
    });

    it('refuses a weak new password', async () => {
      const res = await call('POST', '/api/profile/password', {
        currentPassword: USER.password,
        newPassword: 'weak',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.field).toBe('newPassword');
    });

    it('changes it, and ENDS every session that existed before', async () => {
      const stale = token;
      const res = await call('POST', '/api/profile/password', {
        currentPassword: USER.password,
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBeTruthy();

      // The old token is dead; the returned one works.
      const withStale = await call('GET', '/api/profile', undefined, stale);
      expect(withStale.status).toBe(401);
      expect((await withStale.json()).error.code).toBe('PASSWORD_CHANGED');

      token = body.token;
      expect((await call('GET', '/api/profile')).status).toBe(200);
    });
  });

  describe('notifications', () => {
    it('saves preferences and leaves the others alone', async () => {
      const res = await call('PATCH', '/api/profile/notifications', {
        newBill: false,
        lowCreditThreshold: 25,
      });
      expect(res.status).toBe(200);
      const prefs = (await res.json()).notificationPrefs;
      expect(prefs.newBill).toBe(false);
      expect(prefs.lowCreditThreshold).toBe(25);
      // Untouched keys keep their defaults rather than being wiped.
      expect(prefs.paymentReceipt).toBe(true);
      expect(prefs.lowCredit).toBe(true);
    });

    it('rejects a threshold outside the allowed range', async () => {
      const res = await call('PATCH', '/api/profile/notifications', {
        lowCreditThreshold: 99999,
      });
      expect(res.status).toBe(400);
    });

    it('records an in-app notification when a bill is generated', async () => {
      // Two readings a month apart: the first is the baseline, the second bills.
      await call('POST', '/api/readings', {
        readingDate: '2026-01-01',
        electricityDay: 100,
        electricityNight: 100,
        gas: 100,
      });
      await call('POST', '/api/readings', {
        readingDate: '2026-02-01',
        electricityDay: 400,
        electricityNight: 300,
        gas: 500,
      });

      // The notification is written after the response, so allow a tick.
      await new Promise((r) => setTimeout(r, 400));

      const feed = await (await call('GET', '/api/notifications')).json();
      const bill = feed.notifications.find((n) => n.type === 'new_bill');
      expect(bill).toBeTruthy();
      expect(bill.title).toMatch(/^New bill: £/);
      expect(bill.link).toBe('/bills');
      expect(bill.readAt).toBeNull();
      // newBill email was switched off above, so nothing should have been sent.
      expect(bill.emailed).toBe(false);
      expect(feed.unread).toBeGreaterThan(0);
    });

    it('marks everything read', async () => {
      const res = await call('POST', '/api/notifications/read');
      expect(res.status).toBe(200);
      expect((await res.json()).unread).toBe(0);
      const feed = await (await call('GET', '/api/notifications')).json();
      expect(feed.unread).toBe(0);
      expect(feed.notifications.every((n) => n.readAt !== null)).toBe(true);
    });

    it('never shows one customer another customer notifications', async () => {
      const outsider = {
        ...USER,
        email: 'outsider@shangri-la.sl',
        password: 'Str0ngPass',
      };
      const reg = await (
        await fetch(`${base}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outsider),
        })
      ).json();
      const v = await (
        await fetch(`${base}/api/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: outsider.email, code: reg.devCode }),
        })
      ).json();
      const feed = await (await call('GET', '/api/notifications', undefined, v.token)).json();
      // They have their own Council payment notification, and nothing else:
      // none of this account's bills or receipts leak across.
      expect(feed.notifications.every((n) => n.type === 'council_payment')).toBe(true);
      expect(feed.notifications.some((n) => n.type === 'new_bill')).toBe(false);
    });
  });

  describe('exporting and deleting', () => {
    it('exports the account as a downloadable JSON file', async () => {
      const res = await call('GET', '/api/profile/export');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/attachment/);
      const body = await res.json();
      expect(body.account.email).toBe('ama.moved@shangri-la.sl');
      expect(body.meterReadings.length).toBeGreaterThan(0);
      expect(body.bills.length).toBeGreaterThan(0);
      expect(Array.isArray(body.notifications)).toBe(true);
      // The hash must never leave the server, even in an export to its owner.
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('refuses to close an account that still owes money', async () => {
      const res = await call('DELETE', '/api/profile', {
        password: 'Even5tronger',
        confirm: 'DELETE',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('UNPAID_BILLS');
      // The message names what is owed, rather than just refusing.
      expect(body.error.message).toMatch(/unpaid bill/);
      expect(body.error.message).toMatch(/£\d+\.\d{2}/);

      // And the account is still there.
      const { User } = await import('../src/models/User.js');
      expect(await User.findOne({ email: 'ama.moved@shangri-la.sl' })).toBeTruthy();
    });

    it('settles the outstanding bills', async () => {
      const { bills } = await (await call('GET', '/api/bills')).json();
      const unpaid = bills.filter((b) => b.status === 'unpaid');
      expect(unpaid.length).toBeGreaterThan(0);
      for (const bill of unpaid) {
        const paid = await call('POST', `/api/bills/${bill.id}/pay`);
        expect(paid.status).toBe(200);
      }
      const after = await (await call('GET', '/api/bills')).json();
      expect(after.bills.every((b) => b.status === 'paid')).toBe(true);
    });

    it('refuses deletion without the password and the typed confirmation', async () => {
      const noConfirm = await call('DELETE', '/api/profile', {
        password: 'Even5tronger',
        confirm: 'delete',
      });
      expect(noConfirm.status).toBe(400);

      const wrongPass = await call('DELETE', '/api/profile', {
        password: 'NotIt123',
        confirm: 'DELETE',
      });
      expect(wrongPass.status).toBe(400);
      expect((await wrongPass.json()).error.code).toBe('INVALID_PASSWORD');
    });

    it('deletes the account and everything belonging to it', async () => {
      const { User } = await import('../src/models/User.js');
      const { Bill } = await import('../src/models/Bill.js');
      const { MeterReading } = await import('../src/models/MeterReading.js');
      const { Notification } = await import('../src/models/Notification.js');

      // Captured before the delete, so the cascade can be checked by owner.
      const before = await User.findOne({ email: 'ama.moved@shangri-la.sl' });
      expect(before).toBeTruthy();
      const deletedId = before._id;
      expect(await MeterReading.countDocuments({ userId: deletedId })).toBeGreaterThan(0);

      const res = await call('DELETE', '/api/profile', {
        password: 'Even5tronger',
        confirm: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);

      expect(await User.findById(deletedId)).toBeNull();
      // Scoped to the deleted account: other accounts in this suite keep
      // their own records, so a global count would prove nothing.
      expect(await MeterReading.countDocuments({ userId: deletedId })).toBe(0);
      expect(await Notification.countDocuments({ userId: deletedId })).toBe(0);
      expect(await Bill.countDocuments({ userId: deletedId })).toBe(0);

      // And the token no longer gets in.
      expect((await call('GET', '/api/profile')).status).toBe(401);
    });
  });
});
