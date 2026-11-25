import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectDB, disconnectDB } from '../db.js';
import { User } from '../models/User.js';
import { Tariff } from '../models/Tariff.js';
import { Voucher } from '../models/Voucher.js';
import { CouncilTaxProperty } from '../models/CouncilTaxProperty.js';
import { MeterReading } from '../models/MeterReading.js';
import { Bill } from '../models/Bill.js';
import { Payment } from '../models/Payment.js';
import { createReading } from '../services/billing.js';
import { awardCouncilPaymentIfDue } from '../services/councilPayment.js';
import { normaliseAddress, normalisePostcode } from '../utils/normalise.js';
import { COUNCIL_TAX_PROPERTIES as PROPERTIES } from '../data/councilTaxProperties.js';


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


const DEMO_CUSTOMERS = [
  {
    email: 'alice@shangri-la.sl',
    fullName: 'Alice Tenzin',
    addressLine: '1 Queens Road',
    postcode: 'SL2 7RH',
    propertyType: 'detached',
    start: {
      day: 100,
      night: 250,
      gas: 800,
    },
    step: {
      day: 110,
      night: 260,
      gas: 820,
    },
  },
  {
    email: 'bhuvan@shangri-la.sl',
    fullName: 'Bhuvan Rai',
    addressLine: '10 St Leonards Road',
    postcode: 'LE2 1WS',
    propertyType: 'semi-detached',
    start: {
      day: 320,
      night: 410,
      gas: 1500,
    },
    step: {
      day: 85,
      night: 190,
      gas: 640,
    },
  },
  {
    email: 'chen@shangri-la.sl',
    fullName: 'Chen Dolma',
    addressLine: '20 University Road',
    postcode: 'LE1 7RH',
    propertyType: 'flat',
    start: {
      day: 60,
      night: 140,
      gas: 430,
    },
    step: {
      day: 48,
      night: 96,
      gas: 310,
    },
  },
  {
    email: 'devi@shangri-la.sl',
    fullName: 'Devi Lhamo',
    addressLine: '32 Welford Road',
    postcode: 'SL2 7RH',
    propertyType: 'terraced',
    start: {
      day: 210,
      night: 330,
      gas: 1100,
    },
    step: {
      day: 96,
      night: 215,
      gas: 700,
    },
  },
  {
    email: 'eshan@shangri-la.sl',
    fullName: 'Eshan Norbu',
    addressLine: '45 Kunlun Square',
    postcode: 'SL1 7RH5',
    propertyType: 'mansion',
    start: {
      day: 900,
      night: 1200,
      gas: 4200,
    },
    step: {
      day: 260,
      night: 480,
      gas: 1600,
    },
  },
];


const READING_DATES = ['2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20', '2026-10-20'];


const SEASON = [1, 0.82, 0.74, 0.95, 1.24];
async function seed() {
  console.log('\n  Seeding the MySLP database...\n');
  await connectDB();


  for (const p of PROPERTIES) {
    await CouncilTaxProperty.updateOne(
      {
        addressNormalised: normaliseAddress(p.fullAddress),
      },
      {
        $set: {
          fullAddress: p.fullAddress,
          postcode: p.postcode,
          postcodeNormalised: normalisePostcode(p.postcode),
          addressNormalised: normaliseAddress(p.fullAddress),
          councilTaxBand: p.councilTaxBand,
        },
      },
      {
        upsert: true,
      },
    );
  }
  console.log(`  ✓ ${PROPERTIES.length} council tax properties`);


  for (const code of VOUCHER_CODES) {
    await Voucher.updateOne(
      {
        code,
      },
      {
        $setOnInsert: {
          code,
          value: 200,
          redeemed: false,
        },
      },
      {
        upsert: true,
      },
    );
  }
  console.log(`  ✓ ${VOUCHER_CODES.length} ESSV vouchers`);

  const tariffCount = await Tariff.countDocuments();
  if (tariffCount === 0) {
    await Tariff.create({
      electricityDayRate: 0.34,
      electricityNightRate: 0.2,
      gasRate: 0.1,
      standingChargePerDay: 0,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
    console.log('  ✓ Initial tariff (day 0.34, night 0.20, gas 0.10, standing 0)');
  } else {
    console.log(`  · ${tariffCount} tariff(s) already present, left untouched`);
  }


  const adminEmail = config.adminSeedEmail.toLowerCase();
  const existingAdmin = await User.findOne({
    email: adminEmail,
  });
  if (!existingAdmin) {
    await User.create({
      email: adminEmail,
      passwordHash: await bcrypt.hash(config.adminSeedPassword, config.bcryptRounds),
      fullName: 'MySLP Administrator',
      addressLine: 'Shangri-La Power HQ, 1 Valley Road',
      city: 'Shangri-La',
      postcode: 'SL1 1AA',
      postcodeNormalised: normalisePostcode('SL1 1AA'),
      propertyType: 'detached',
      councilTaxBand: null,
      role: 'admin',
      emailVerified: true,
      energyCredit: 0,
    });
    console.log(`  ✓ Administrator ${adminEmail} / ${config.adminSeedPassword}`);
  } else {
    console.log(`  · Administrator ${adminEmail} already exists`);
  }


  const demoHash = await bcrypt.hash(config.demoSeedPassword, config.bcryptRounds);
  for (const demo of DEMO_CUSTOMERS) {
    let user = await User.findOne({
      email: demo.email,
    });
    if (user) {
      console.log(`  · ${demo.email} already exists, skipping`);
      continue;
    }
    const property = PROPERTIES.find(
      (p) =>
        normaliseAddress(p.fullAddress) === normaliseAddress(`${demo.addressLine}, Shangri-La`),
    );
    user = await User.create({
      email: demo.email,
      passwordHash: demoHash,
      fullName: demo.fullName,
      addressLine: demo.addressLine,
      city: 'Shangri-La',
      postcode: demo.postcode,
      postcodeNormalised: normalisePostcode(demo.postcode),
      propertyType: demo.propertyType,
      councilTaxBand: property?.councilTaxBand ?? null,
      role: 'customer',
      emailVerified: true,
      energyCredit: config.startingEnergyCredit,
    });

    await awardCouncilPaymentIfDue(user);
    let day = demo.start.day;
    let night = demo.start.night;
    let gas = demo.start.gas;
    for (let i = 0; i < READING_DATES.length; i += 1) {
      if (i > 0) {
        day += Math.round(demo.step.day * SEASON[i]);
        night += Math.round(demo.step.night * SEASON[i]);
        gas += Math.round(demo.step.gas * SEASON[i]);
      }
      await createReading(user._id, {
        readingDate: READING_DATES[i],
        electricityDay: day,
        electricityNight: night,
        gas,
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
    console.log(
      `  ✓ ${demo.fullName} (${demo.email}) — band ${user.councilTaxBand ?? '-'}, ${bills.length} bills`,
    );
  }
  const counts = {
    users: await User.countDocuments(),
    readings: await MeterReading.countDocuments(),
    bills: await Bill.countDocuments(),
    payments: await Payment.countDocuments(),
    vouchers: await Voucher.countDocuments(),
    properties: await CouncilTaxProperty.countDocuments(),
    tariffs: await Tariff.countDocuments(),
  };
  console.log('\n  Done. Collection counts:', counts);
  console.log(`\n  Admin:    ${config.adminSeedEmail} / ${config.adminSeedPassword}`);
  console.log(`  Customer: ${DEMO_CUSTOMERS[0].email} / ${config.demoSeedPassword}\n`);
  await disconnectDB();
}
seed().catch(async (err) => {
  console.error('\n  Seed failed:', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
