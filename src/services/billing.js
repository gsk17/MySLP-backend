import mongoose from 'mongoose';
import { MeterReading } from '../models/MeterReading.js';
import { Bill } from '../models/Bill.js';
import { getActiveTariff } from '../models/Tariff.js';
import { supportsTransactions } from '../db.js';
import { ApiError, badRequest } from '../utils/errors.js';
import { dayCount, formatDate, round2, todayUtc, toUtcDate } from '../utils/normalise.js';
const REGISTER_LABELS = {
  electricityDay: 'Daytime electricity',
  electricityNight: 'Night-time',
  gas: 'Gas',
};

/**
 * Pure calculation of a bill from two readings and a tariff.
 * Exported so it can be unit-tested without a database.
 *
 * Billing rules (coursework Appendix 3):
 *  - usage per register = latest reading - previous reading
 *  - cost  per register = usage x the register's price per kWh
 *  - days  = previous reading date UP TO BUT EXCLUDING the latest reading date
 *  - standing charge = days x the daily standing charge
 *  - total = the three usage charges + the standing charge
 */
export function calculateBill(previous, latest, tariff) {
  const dayKwh = round2(latest.electricityDay - previous.electricityDay);
  const nightKwh = round2(latest.electricityNight - previous.electricityNight);
  const gasKwh = round2(latest.gas - previous.gas);
  const days = dayCount(previous.readingDate, latest.readingDate);
  const dayCost = round2(dayKwh * tariff.electricityDayRate);
  const nightCost = round2(nightKwh * tariff.electricityNightRate);
  const gasCost = round2(gasKwh * tariff.gasRate);
  const standingCost = round2(days * tariff.standingChargePerDay);
  const totalAmount = round2(dayCost + nightCost + gasCost + standingCost);
  return {
    periodStart: previous.readingDate,
    periodEnd: latest.readingDate,
    days,
    dayKwh,
    nightKwh,
    gasKwh,
    dayCost,
    nightCost,
    gasCost,
    standingCost,
    totalAmount,
  };
}

/**
 * Validates a submission against the customer's previous reading.
 * Throws an ApiError naming the offending register, both values and the date.
 */
export function validateAgainstPrevious(previous, latest) {
  if (latest.readingDate.getTime() <= previous.readingDate.getTime()) {
    throw badRequest(
      'READING_DATE_NOT_AFTER_PREVIOUS',
      `The submission date must be after your previous reading on ${formatDate(previous.readingDate)}.`,
      'readingDate',
    );
  }
  for (const register of ['electricityDay', 'electricityNight', 'gas']) {
    const newValue = latest[register];
    const oldValue = previous[register];
    if (newValue < oldValue) {
      throw badRequest(
        'READING_LOWER_THAN_PREVIOUS',
        `${REGISTER_LABELS[register]} reading (${newValue} kWh) is lower than your previous reading of ${oldValue} kWh submitted on ${formatDate(previous.readingDate)}.`,
        register,
      );
    }
  }
}

/** The customer's most recent reading, or null if they have never submitted one. */
export async function findPreviousReading(userId) {
  return MeterReading.findOne({
    userId,
  })
    .sort({
      readingDate: -1,
      createdAt: -1,
    })
    .exec();
}

/**
 * Submit a set of meter readings.
 *
 * The FIRST submission is stored as the baseline and generates NO bill.
 * Every later submission is validated, then billed against the previous one
 * using the tariff in effect at the moment of calculation.
 */
export async function createReading(userId, input) {
  const readingDate = toUtcDate(input.readingDate);
  if (readingDate.getTime() > todayUtc().getTime()) {
    throw badRequest(
      'READING_DATE_IN_FUTURE',
      'The submission date cannot be in the future.',
      'readingDate',
    );
  }
  const latest = {
    readingDate,
    electricityDay: input.electricityDay,
    electricityNight: input.electricityNight,
    gas: input.gas,
  };
  const previous = await findPreviousReading(userId);

  // ---- First ever submission: baseline only, no bill. ----------------------
  if (!previous) {
    const reading = await MeterReading.create({
      userId,
      readingDate,
      electricityDay: latest.electricityDay,
      electricityNight: latest.electricityNight,
      gas: latest.gas,
      isBaseline: true,
    });
    return {
      reading: reading,
      bill: null,
    };
  }

  // ---- Validate BEFORE writing anything. -----------------------------------
  validateAgainstPrevious(previous, latest);
  const tariff = await getActiveTariff();
  const computed = calculateBill(previous, latest, tariff);
  const readingDoc = {
    userId,
    readingDate,
    electricityDay: latest.electricityDay,
    electricityNight: latest.electricityNight,
    gas: latest.gas,
    isBaseline: false,
  };
  const makeBillDoc = (readingId) => ({
    userId,
    readingId,
    previousReadingId: previous._id,
    ...computed,
    status: 'unpaid',
    paidAt: null,
    tariffId: tariff._id,
    tariffSnapshot: {
      electricityDayRate: tariff.electricityDayRate,
      electricityNightRate: tariff.electricityNightRate,
      gasRate: tariff.gasRate,
      standingChargePerDay: tariff.standingChargePerDay,
    },
  });

  // ---- Write the reading and its bill atomically. ---------------------------
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const [reading] = await MeterReading.create([readingDoc], {
          session,
        });
        const [bill] = await Bill.create([makeBillDoc(reading._id)], {
          session,
        });
        result = {
          reading: reading,
          bill: bill,
        };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // Standalone mongod (local dev / tests) has no transactions: best effort with
  // a compensating delete so we never leave a reading without its bill.
  const reading = await MeterReading.create(readingDoc);
  try {
    const bill = await Bill.create(makeBillDoc(reading._id));
    return {
      reading,
      bill,
    };
  } catch (err) {
    await MeterReading.deleteOne({
      _id: reading._id,
    }).catch(() => undefined);
    throw err instanceof ApiError
      ? err
      : badRequest('BILL_CREATION_FAILED', 'The bill could not be generated. Please try again.');
  }
}
