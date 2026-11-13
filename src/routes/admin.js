import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, rejectStaleSession } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { Tariff, getActiveTariff } from '../models/Tariff.js';
import { User } from '../models/User.js';
import { MeterReading } from '../models/MeterReading.js';
import { Bill } from '../models/Bill.js';
import { Payment } from '../models/Payment.js';
import { Voucher } from '../models/Voucher.js';
import { adminStatistics, customerConsumptionAverages } from '../services/statistics.js';
import { notFound } from '../utils/errors.js';
const router = Router();
router.use(requireAuth, rejectStaleSession, requireAdmin);
const tariffSchema = z.object({
  electricityDayRate: z
    .number({
      invalid_type_error: 'Enter the daytime electricity rate.',
    })
    .min(0, 'A rate cannot be negative.')
    .max(100, 'That rate looks too high.'),
  electricityNightRate: z
    .number({
      invalid_type_error: 'Enter the night-time electricity rate.',
    })
    .min(0, 'A rate cannot be negative.')
    .max(100, 'That rate looks too high.'),
  gasRate: z
    .number({
      invalid_type_error: 'Enter the gas rate.',
    })
    .min(0, 'A rate cannot be negative.')
    .max(100, 'That rate looks too high.'),
  standingChargePerDay: z
    .number({
      invalid_type_error: 'Enter the daily standing charge.',
    })
    .min(0, 'A standing charge cannot be negative.')
    .max(100, 'That standing charge looks too high.')
    .default(0),
});

// ---------------------------------------------------------------------------
// Tariffs — append-only
// ---------------------------------------------------------------------------
router.get(
  '/tariffs',
  asyncHandler(async (_req, res) => {
    const [tariffs, active] = await Promise.all([
      Tariff.find()
        .sort({
          effectiveFrom: -1,
        })
        .populate('createdBy', 'fullName email')
        .exec(),
      getActiveTariff(),
    ]);
    res.json({
      tariffs: tariffs.map((t) => t.toJSON()),
      active: active.toJSON(),
    });
  }),
);
router.post(
  '/tariffs',
  validate(tariffSchema),
  asyncHandler(async (req, res) => {
    const input = req.body;
    const tariff = await Tariff.create({
      ...input,
      effectiveFrom: new Date(),
      createdBy: req.user.sub,
    });
    res.status(201).json({
      tariff: tariff.toJSON(),
      message: 'New tariff saved. It applies to every bill calculated from now on.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
router.get(
  '/customers',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : '-createdAt';
    const filter = {
      role: 'customer',
    };
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        {
          fullName: rx,
        },
        {
          email: rx,
        },
        {
          addressLine: rx,
        },
        {
          postcode: rx,
        },
        {
          councilTaxBand: rx,
        },
      ];
    }
    const allowedSorts = new Set([
      'fullName',
      '-fullName',
      'email',
      '-email',
      'energyCredit',
      '-energyCredit',
      'councilTaxBand',
      '-councilTaxBand',
      'createdAt',
      '-createdAt',
    ]);
    const safeSort = allowedSorts.has(sort) ? sort : '-createdAt';
    const [customers, total] = await Promise.all([
      User.find(filter)
        .sort(safeSort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      User.countDocuments(filter),
    ]);

    // Unpaid bill count per listed customer, in one query.
    const ids = customers.map((c) => c._id);
    const unpaid = await Bill.aggregate([
      {
        $match: {
          userId: {
            $in: ids,
          },
          status: 'unpaid',
        },
      },
      {
        $group: {
          _id: '$userId',
          count: {
            $sum: 1,
          },
          amount: {
            $sum: '$totalAmount',
          },
        },
      },
    ]);
    const unpaidByUser = new Map(unpaid.map((u) => [String(u._id), u]));
    res.json({
      customers: customers.map((c) => ({
        ...c.toJSON(),
        unpaidBills: unpaidByUser.get(String(c._id))?.count ?? 0,
        outstanding: unpaidByUser.get(String(c._id))?.amount ?? 0,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  }),
);
router.get(
  '/customers/:id',
  asyncHandler(async (req, res) => {
    const customer = await User.findById(req.params.id);
    if (!customer) {
      throw notFound('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
    }
    const [readings, bills, payments, averages] = await Promise.all([
      MeterReading.find({
        userId: customer._id,
      })
        .sort({
          readingDate: -1,
        })
        .exec(),
      Bill.find({
        userId: customer._id,
      })
        .sort({
          periodEnd: -1,
        })
        .exec(),
      Payment.find({
        userId: customer._id,
      })
        .sort({
          createdAt: -1,
        })
        .exec(),
      customerConsumptionAverages(customer._id),
    ]);
    res.json({
      customer: customer.toJSON(),
      readings: readings.map((r) => r.toJSON()),
      bills: bills.map((b) => b.toJSON()),
      payments: payments.map((p) => p.toJSON()),
      averages,
    });
  }),
);

// ---------------------------------------------------------------------------
// Statistics and vouchers
// ---------------------------------------------------------------------------
router.get(
  '/statistics',
  asyncHandler(async (_req, res) => {
    res.json(await adminStatistics());
  }),
);
router.get(
  '/vouchers',
  asyncHandler(async (_req, res) => {
    const vouchers = await Voucher.find()
      .sort({
        redeemed: 1,
        code: 1,
      })
      .populate('redeemedBy', 'fullName email')
      .exec();
    res.json({
      vouchers: vouchers.map((v) => v.toJSON()),
      redeemed: vouchers.filter((v) => v.redeemed).length,
      total: vouchers.length,
    });
  }),
);
export default router;
