/**
 * Zero-setup local demo: starts an in-memory MongoDB, seeds it, and serves the
 * API — no Atlas account or local mongod required.
 *
 *   npm run dev:memory
 *
 * Data is discarded when the process exits. Use `npm run dev` with a real
 * MONGODB_URI for anything you want to keep, and for the submitted build.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { COUNCIL_TAX_PROPERTIES as PROPERTIES } from '../data/councilTaxProperties.js';
async function main() {
  console.log('\n  Starting an in-memory MongoDB (first run downloads the binary)...');
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('myslp');
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-in-memory-secret';
  process.env.NODE_ENV = 'development';
  const { connectDB } = await import('../db.js');
  await connectDB(uri);
  console.log('  ✓ In-memory MongoDB ready');

  // Seed through the real services so the demo data is genuine.
  const bcrypt = (await import('bcryptjs')).default;
  const { config } = await import('../config.js');
  const { User } = await import('../models/User.js');
  const { Tariff } = await import('../models/Tariff.js');
  const { Voucher } = await import('../models/Voucher.js');
  const { CouncilTaxProperty } = await import('../models/CouncilTaxProperty.js');
  const { Bill } = await import('../models/Bill.js');
  const { Payment } = await import('../models/Payment.js');
  const { createReading } = await import('../services/billing.js');
  const { normaliseAddress, normalisePostcode } = await import('../utils/normalise.js');
  const VOUCHER_CODES = [
    '1AZN0FXJVM',
    'JOV50TOSYR',
    'E4GE75H7Q6',
    'ELZP1KE1XL',
    'XD5EVTWLVV',
    'G04WANUF1U',
    'JMSW12NWE0',
    'P13HNPVP46',
    '9HDBPYG1YD',
    '1T8APVLH5W',
    '5LAE3L3USE',
    'B81G5K9PZX',
    'VD0L7GY3S2',
    '9D6WMCL3H0',
    'EN3WF2BNSJ',
    'RFR6022SAM',
    'M6JKQP7PAT',
    'KPPESECCNH',
    '3TFBNAVAE7',
    'YC1HGA9471',
    'NV0DVMH9MA',
    'YTAQ39BR27',
  ];
  await CouncilTaxProperty.insertMany(
    PROPERTIES.map((p) => ({
      ...p,
      postcodeNormalised: normalisePostcode(p.postcode),
      addressNormalised: normaliseAddress(p.fullAddress),
    })),
  );
  await Voucher.insertMany(
    VOUCHER_CODES.map((code) => ({
      code,
      value: 200,
      redeemed: false,
    })),
  );
  await Tariff.create({
    electricityDayRate: 0.34,
    electricityNightRate: 0.2,
    gasRate: 0.1,
    standingChargePerDay: 0,
    effectiveFrom: new Date('2026-01-01'),
  });
  await User.create({
    email: config.adminSeedEmail.toLowerCase(),
    passwordHash: await bcrypt.hash(config.adminSeedPassword, 10),
    fullName: 'MySLP Administrator',
    addressLine: 'Shangri-La Power HQ, 1 Valley Road',
    city: 'Shangri-La',
    postcode: 'SL1 1AA',
    postcodeNormalised: 'SL11AA',
    propertyType: 'detached',
    role: 'admin',
    energyCredit: 0,
  });
  const demoHash = await bcrypt.hash(config.demoSeedPassword, 10);
  const DEMOS = [
    {
      email: 'alice@shangri-la.sl',
      name: 'Alice Tenzin',
      line: '1 Queens Road',
      pc: 'SL2 7RH',
      type: 'detached',
      s: [100, 250, 800],
      d: [110, 260, 820],
    },
    {
      email: 'bhuvan@shangri-la.sl',
      name: 'Bhuvan Rai',
      line: '10 St Leonards Road',
      pc: 'LE2 1WS',
      type: 'semi-detached',
      s: [320, 410, 1500],
      d: [85, 190, 640],
    },
    {
      email: 'chen@shangri-la.sl',
      name: 'Chen Dolma',
      line: '20 University Road',
      pc: 'LE1 7RH',
      type: 'flat',
      s: [60, 140, 430],
      d: [48, 96, 310],
    },
    {
      email: 'devi@shangri-la.sl',
      name: 'Devi Lhamo',
      line: '32 Welford Road',
      pc: 'SL2 7RH',
      type: 'terraced',
      s: [210, 330, 1100],
      d: [96, 215, 700],
    },
  ];
  const DATES = ['2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20', '2026-10-20'];
  // Seasonal variation so the charts show a realistic shape rather than a flat line.
  const SEASON = [1, 0.82, 0.74, 0.95, 1.24];
  for (const demo of DEMOS) {
    const property = PROPERTIES.find(
      (p) => normaliseAddress(p.fullAddress) === normaliseAddress(`${demo.line}, Shangri-La`),
    );
    const user = await User.create({
      email: demo.email,
      passwordHash: demoHash,
      fullName: demo.name,
      addressLine: demo.line,
      city: 'Shangri-La',
      postcode: demo.pc,
      postcodeNormalised: normalisePostcode(demo.pc),
      propertyType: demo.type,
      councilTaxBand: property?.councilTaxBand ?? null,
      role: 'customer',
      emailVerified: true,
      energyCredit: 500,
    });
    let acc = [demo.s[0], demo.s[1], demo.s[2]];
    for (let i = 0; i < DATES.length; i += 1) {
      if (i > 0) {
        acc = [
          acc[0] + Math.round(demo.d[0] * SEASON[i]),
          acc[1] + Math.round(demo.d[1] * SEASON[i]),
          acc[2] + Math.round(demo.d[2] * SEASON[i]),
        ];
      }
      await createReading(user._id, {
        readingDate: DATES[i],
        electricityDay: acc[0],
        electricityNight: acc[1],
        gas: acc[2],
      });
    }
    const bills = await Bill.find({
      userId: user._id,
    }).sort({
      periodEnd: 1,
    });
    for (const bill of bills.slice(0, -1)) {
      const fresh = await User.findById(user._id);
      if (!fresh || fresh.energyCredit < bill.totalAmount) break;
      bill.status = 'paid';
      bill.paidAt = new Date(bill.periodEnd);
      await bill.save();
      fresh.energyCredit = Math.round((fresh.energyCredit - bill.totalAmount) * 100) / 100;
      await fresh.save();
      await Payment.create({
        userId: user._id,
        billId: bill._id,
        type: 'bill_payment',
        amount: -bill.totalAmount,
        balanceAfter: fresh.energyCredit,
      });
    }
  }
  console.log('  ✓ Seeded 4 demo customers, 22 vouchers, 5 properties, 1 tariff');
  const { default: app } = await import('../app.js');
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`\n  MySLP API (in-memory) on http://localhost:${port}`);
    console.log(`  Admin:    ${config.adminSeedEmail} / ${config.adminSeedPassword}`);
    console.log(`  Customer: alice@shangri-la.sl / ${config.demoSeedPassword}`);
    console.log(`\n  Try:  curl "http://localhost:${port}/rest/statistics/A/SL2"\n`);
  });
  const shutdown = async () => {
    await mongo.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => {
  console.error('Failed to start the in-memory demo:', err);
  process.exit(1);
});
