import { Types } from 'mongoose';
import { Bill } from '../models/Bill.js';
import { MeterReading } from '../models/MeterReading.js';
import { User } from '../models/User.js';
import { Payment } from '../models/Payment.js';
import { Voucher } from '../models/Voucher.js';
import { normalisePostcode, round2 } from '../utils/normalise.js';

/**
 * Average combined electricity + gas cost per day for every property in a
 * council tax band whose postcode starts with the given prefix.
 *
 * The standing charge is deliberately EXCLUDED: the field is named
 * `average_electricity_gas_cost_per_day`, so it covers energy usage only.
 */
export async function averageEnergyCostPerDay(band, postcodePrefix) {
  const prefix = normalisePostcode(postcodePrefix);
  const bandUpper = band.toUpperCase();
  const users = await User.find({
    councilTaxBand: bandUpper,
    postcodeNormalised: new RegExp(`^${escapeRegex(prefix)}`),
  })
    .select('_id')
    .lean();
  if (users.length === 0) {
    return {
      average: 0,
      propertiesMatched: 0,
      billsCounted: 0,
    };
  }
  const [totals] = await Bill.aggregate([
    {
      $match: {
        userId: {
          $in: users.map((u) => u._id),
        },
      },
    },
    {
      $group: {
        _id: null,
        energyCost: {
          $sum: {
            $add: ['$dayCost', '$nightCost', '$gasCost'],
          },
        },
        days: {
          $sum: '$days',
        },
        bills: {
          $sum: 1,
        },
      },
    },
  ]);
  if (!totals || !totals.days) {
    return {
      average: 0,
      propertiesMatched: users.length,
      billsCounted: totals?.bills ?? 0,
    };
  }
  return {
    average: round2(totals.energyCost / totals.days),
    propertiesMatched: users.length,
    billsCounted: totals.bills,
  };
}

/** Per-customer averages, in kWh, for the administrator dashboard. */
export async function customerConsumptionAverages(userId) {
  const [agg] = await Bill.aggregate([
    {
      $match: {
        userId: new Types.ObjectId(String(userId)),
      },
    },
    {
      $group: {
        _id: null,
        electricityKwh: {
          $sum: {
            $add: ['$dayKwh', '$nightKwh'],
          },
        },
        gasKwh: {
          $sum: '$gasKwh',
        },
        days: {
          $sum: '$days',
        },
        periods: {
          $sum: 1,
        },
      },
    },
  ]);
  if (!agg || agg.periods === 0) {
    return {
      periods: 0,
      totalDays: 0,
      averageElectricityKwhPerPeriod: 0,
      averageGasKwhPerPeriod: 0,
      averageElectricityKwhPerDay: 0,
      averageGasKwhPerDay: 0,
      totalElectricityKwh: 0,
      totalGasKwh: 0,
    };
  }
  return {
    periods: agg.periods,
    totalDays: agg.days,
    averageElectricityKwhPerPeriod: round2(agg.electricityKwh / agg.periods),
    averageGasKwhPerPeriod: round2(agg.gasKwh / agg.periods),
    averageElectricityKwhPerDay: agg.days ? round2(agg.electricityKwh / agg.days) : 0,
    averageGasKwhPerDay: agg.days ? round2(agg.gasKwh / agg.days) : 0,
    totalElectricityKwh: round2(agg.electricityKwh),
    totalGasKwh: round2(agg.gasKwh),
  };
}

/** Headline numbers and breakdowns for the administrator overview. */
export async function adminStatistics() {
  const [customers, totalsAgg, revenueAgg, vouchersRedeemed, byBand, byPrefix] = await Promise.all([
    User.countDocuments({
      role: 'customer',
    }),
    Bill.aggregate([
      {
        $group: {
          _id: null,
          totalBilled: {
            $sum: '$totalAmount',
          },
          outstanding: {
            $sum: {
              $cond: [
                {
                  $eq: ['$status', 'unpaid'],
                },
                '$totalAmount',
                0,
              ],
            },
          },
          unpaidCount: {
            $sum: {
              $cond: [
                {
                  $eq: ['$status', 'unpaid'],
                },
                1,
                0,
              ],
            },
          },
          electricityKwh: {
            $sum: {
              $add: ['$dayKwh', '$nightKwh'],
            },
          },
          gasKwh: {
            $sum: '$gasKwh',
          },
          bills: {
            $sum: 1,
          },
        },
      },
    ]),
    Payment.aggregate([
      {
        $match: {
          type: 'bill_payment',
        },
      },
      {
        $group: {
          _id: null,
          collected: {
            $sum: {
              $abs: '$amount',
            },
          },
        },
      },
    ]),
    Voucher.countDocuments({
      redeemed: true,
    }),
    consumptionByBand(),
    consumptionByPostcodePrefix(),
  ]);
  const totals = totalsAgg[0] ?? {
    totalBilled: 0,
    outstanding: 0,
    unpaidCount: 0,
    electricityKwh: 0,
    gasKwh: 0,
    bills: 0,
  };
  return {
    totals: {
      customers,
      bills: totals.bills,
      totalBilled: round2(totals.totalBilled),
      revenueCollected: round2(revenueAgg[0]?.collected ?? 0),
      outstanding: round2(totals.outstanding),
      unpaidBills: totals.unpaidCount,
      vouchersRedeemed,
      totalElectricityKwh: round2(totals.electricityKwh),
      totalGasKwh: round2(totals.gasKwh),
      totalKwh: round2(totals.electricityKwh + totals.gasKwh),
    },
    byBand,
    byPostcodePrefix: byPrefix,
  };
}
async function consumptionByBand() {
  const rows = await User.aggregate([
    {
      $match: {
        role: 'customer',
        councilTaxBand: {
          $ne: null,
        },
      },
    },
    {
      $lookup: {
        from: 'bills',
        localField: '_id',
        foreignField: 'userId',
        as: 'bills',
      },
    },
    {
      $unwind: {
        path: '$bills',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $group: {
        _id: '$councilTaxBand',
        customers: {
          $addToSet: '$_id',
        },
        electricityKwh: {
          $sum: {
            $add: ['$bills.dayKwh', '$bills.nightKwh'],
          },
        },
        gasKwh: {
          $sum: '$bills.gasKwh',
        },
        billed: {
          $sum: '$bills.totalAmount',
        },
      },
    },
    {
      $project: {
        _id: 0,
        band: '$_id',
        customers: {
          $size: '$customers',
        },
        electricityKwh: {
          $round: ['$electricityKwh', 2],
        },
        gasKwh: {
          $round: ['$gasKwh', 2],
        },
        billed: {
          $round: ['$billed', 2],
        },
      },
    },
    {
      $sort: {
        band: 1,
      },
    },
  ]);
  return rows;
}
async function consumptionByPostcodePrefix() {
  const rows = await User.aggregate([
    {
      $match: {
        role: 'customer',
      },
    },
    {
      $lookup: {
        from: 'bills',
        localField: '_id',
        foreignField: 'userId',
        as: 'bills',
      },
    },
    {
      $unwind: {
        path: '$bills',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $group: {
        _id: {
          $substrCP: ['$postcodeNormalised', 0, 3],
        },
        customers: {
          $addToSet: '$_id',
        },
        electricityKwh: {
          $sum: {
            $add: ['$bills.dayKwh', '$bills.nightKwh'],
          },
        },
        gasKwh: {
          $sum: '$bills.gasKwh',
        },
        billed: {
          $sum: '$bills.totalAmount',
        },
      },
    },
    {
      $project: {
        _id: 0,
        prefix: '$_id',
        customers: {
          $size: '$customers',
        },
        electricityKwh: {
          $round: ['$electricityKwh', 2],
        },
        gasKwh: {
          $round: ['$gasKwh', 2],
        },
        billed: {
          $round: ['$billed', 2],
        },
      },
    },
    {
      $sort: {
        prefix: 1,
      },
    },
  ]);
  return rows;
}

/** Time series + averages powering the customer's Usage screen. */
export async function customerUsage(userId) {
  const id = new Types.ObjectId(String(userId));
  const [bills, readings, averages] = await Promise.all([
    Bill.find({
      userId: id,
    })
      .sort({
        periodEnd: 1,
      })
      .lean(),
    MeterReading.find({
      userId: id,
    })
      .sort({
        readingDate: 1,
      })
      .lean(),
    customerConsumptionAverages(id),
  ]);
  const series = bills.map((b) => ({
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    days: b.days,
    dayKwh: b.dayKwh,
    nightKwh: b.nightKwh,
    gasKwh: b.gasKwh,
    electricityKwh: round2(b.dayKwh + b.nightKwh),
    dayCost: b.dayCost,
    nightCost: b.nightCost,
    gasCost: b.gasCost,
    standingCost: b.standingCost,
    totalAmount: b.totalAmount,
    status: b.status,
  }));
  const costSplit = series.reduce(
    (acc, s) => ({
      day: round2(acc.day + s.dayCost),
      night: round2(acc.night + s.nightCost),
      gas: round2(acc.gas + s.gasCost),
      standing: round2(acc.standing + s.standingCost),
    }),
    {
      day: 0,
      night: 0,
      gas: 0,
      standing: 0,
    },
  );
  return {
    series,
    costSplit,
    averages,
    readingCount: readings.length,
    latestReading: readings[readings.length - 1] ?? null,
  };
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
