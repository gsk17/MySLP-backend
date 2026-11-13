import express, { Router } from 'express';
import { z } from 'zod';
import { requireAuth, rejectStaleSession } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { User } from '../models/User.js';
import { MeterReading } from '../models/MeterReading.js';
import { Bill } from '../models/Bill.js';
import { Payment } from '../models/Payment.js';
import { getActiveTariff } from '../models/Tariff.js';
import { createReading, findPreviousReading } from '../services/billing.js';
import { payBill, redeemVoucher } from '../services/payments.js';
import { customerUsage } from '../services/statistics.js';
import { readMeterImage, readVoucherImage } from '../services/ocr.js';
import {
  notifyNewBill,
  notifyPaymentReceipt,
  notifyLowCreditIfCrossed,
} from '../services/notifications.js';
import { notFound } from '../utils/errors.js';
const router = Router();

// Everything in this router is for the signed-in customer only. Queries are
// ALWAYS scoped by req.user.sub, never by an id taken from the request.
router.use(requireAuth, rejectStaleSession);
const readingSchema = z.object({
  readingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
    .optional()
    .default(() => new Date().toISOString().slice(0, 10)),
  electricityDay: z
    .number({
      invalid_type_error: 'Enter the daytime electricity reading.',
    })
    .min(0, 'A meter reading cannot be negative.')
    .finite(),
  electricityNight: z
    .number({
      invalid_type_error: 'Enter the night-time electricity reading.',
    })
    .min(0, 'A meter reading cannot be negative.')
    .finite(),
  gas: z
    .number({
      invalid_type_error: 'Enter the gas reading.',
    })
    .min(0, 'A meter reading cannot be negative.')
    .finite(),
});
const voucherSchema = z.object({
  code: z
    .string({
      required_error: 'Enter a voucher code.',
    })
    .trim()
    .min(1, 'Enter a voucher code.'),
});

// ---------------------------------------------------------------------------
// GET /api/profile — the dashboard header payload
// ---------------------------------------------------------------------------
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const [user, tariff, previousReading, unpaid] = await Promise.all([
      User.findById(req.user.sub),
      getActiveTariff(),
      findPreviousReading(req.user.sub),
      Bill.findOne({
        userId: req.user.sub,
        status: 'unpaid',
      }).sort({
        periodEnd: 1,
      }),
    ]);
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    res.json({
      profile: user.toJSON(),
      councilPaymentEligible: ['A', 'B', 'C', 'D'].includes(user.councilTaxBand ?? ''),
      tariff: tariff.toJSON(),
      previousReading: previousReading ? previousReading.toJSON() : null,
      oldestUnpaidBill: unpaid ? unpaid.toJSON() : null,
    });
  }),
);

// ---------------------------------------------------------------------------
// Meter readings
// ---------------------------------------------------------------------------
router.get(
  '/readings',
  asyncHandler(async (req, res) => {
    const readings = await MeterReading.find({
      userId: req.user.sub,
    })
      .sort({
        readingDate: -1,
      })
      .exec();
    res.json({
      readings: readings.map((r) => r.toJSON()),
    });
  }),
);
/**
 * Read a meter photograph. Returns candidate numbers for the customer to
 * check — it never creates a reading.
 */
router.post(
  '/readings/scan',
  // Its own parser: the global one caps JSON at 100kb, and a base64 photo is
  // far larger. 2mb covers OCR.space's own 1MB file limit once encoded.
  express.json({ limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const result = await readMeterImage(req.body?.image);
    res.json({
      ...result,
      message: result.readings.length
        ? 'Check these against your meter before submitting.'
        : 'No numbers could be read from that photo. Try again, or enter them by hand.',
    });
  }),
);

router.post(
  '/readings',
  validate(readingSchema),
  asyncHandler(async (req, res) => {
    const input = req.body;
    const { reading, bill } = await createReading(req.user.sub, input);
    // Fire and forget: a notification must never fail the submission, and the
    // customer should not wait on an SMTP round trip to see their bill.
    if (bill) void notifyNewBill(req.user.sub, bill);
    res.status(201).json({
      reading: reading.toJSON(),
      bill: bill ? bill.toJSON() : null,
      message: bill
        ? 'Readings submitted. Your new bill is ready.'
        : 'Baseline readings saved — no bill is generated for your first submission.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
router.get(
  '/bills',
  asyncHandler(async (req, res) => {
    const bills = await Bill.find({
      userId: req.user.sub,
    })
      .sort({
        periodEnd: -1,
      })
      .exec();
    const oldestUnpaid = bills
      .filter((b) => b.status === 'unpaid')
      .sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime())[0];
    res.json({
      bills: bills.map((b) => b.toJSON()),
      oldestUnpaidId: oldestUnpaid ? String(oldestUnpaid._id) : null,
    });
  }),
);
router.post(
  '/bills/:id/pay',
  asyncHandler(async (req, res) => {
    // Read the balance before the payment so the low-credit alert can fire on
    // the crossing only, rather than on every payment made while already low.
    const before = (await User.findById(req.user.sub).select('energyCredit'))?.energyCredit ?? 0;
    const { bill, energyCredit } = await payBill(req.user.sub, req.params.id);
    void notifyPaymentReceipt(req.user.sub, {
      bill,
      amount: bill.totalAmount,
      remainingCredit: energyCredit,
    });
    void notifyLowCreditIfCrossed(req.user.sub, before, energyCredit);
    res.json({
      bill: bill.toJSON(),
      energyCredit,
      message: `Bill paid. £${bill.totalAmount.toFixed(2)} taken from your energy credit.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// Vouchers and payments
// ---------------------------------------------------------------------------
/**
 * Read a voucher photograph. Returns candidate codes; it never redeems one.
 */
router.post(
  '/vouchers/scan',
  express.json({ limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const result = await readVoucherImage(req.body?.image);
    res.json({
      ...result,
      message: result.codes.length
        ? 'Check this against the voucher before redeeming.'
        : 'No 10-character code could be read. Try again, or type it in.',
    });
  }),
);

router.post(
  '/vouchers/redeem',
  validate(voucherSchema),
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const result = await redeemVoucher(req.user.sub, code);
    res.json({
      ...result,
      message: `Voucher redeemed — £${result.amount.toFixed(2)} added to your energy credit.`,
    });
  }),
);
router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const payments = await Payment.find({
      userId: req.user.sub,
    })
      .sort({
        createdAt: -1,
      })
      .exec();
    res.json({
      payments: payments.map((p) => p.toJSON()),
    });
  }),
);

// ---------------------------------------------------------------------------
// Usage / charts
// ---------------------------------------------------------------------------
router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json(await customerUsage(req.user.sub));
  }),
);
export default router;
