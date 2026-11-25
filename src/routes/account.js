import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { requireAuth, rejectStaleSession, sessionPayload, signToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { User, PROPERTY_TYPES } from '../models/User.js';
import { Bill } from '../models/Bill.js';
import { MeterReading } from '../models/MeterReading.js';
import { Payment } from '../models/Payment.js';
import { Notification } from '../models/Notification.js';
import { EmailVerification } from '../models/EmailVerification.js';
import { lookupCouncilTaxBand } from '../services/councilTax.js';
import { awardCouncilPaymentIfDue } from '../services/councilPayment.js';
import { issueEmailChangeCode, verifyRawCode } from '../services/otp.js';
import { normalisePostcode } from '../utils/normalise.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

const router = Router();
router.use(requireAuth, rejectStaleSession);

/* ------------------------------------------------------------------------ */
/* Address and property type                                                */
/* ------------------------------------------------------------------------ */

const addressSchema = z.object({
  addressLine: z.string().trim().min(3, 'Enter your address.').max(200),
  city: z.string().trim().min(2, 'Enter your town or city.').max(100),
  postcode: z.string().trim().min(3, 'Enter your postcode.').max(12),
  propertyType: z.enum(PROPERTY_TYPES, {
    errorMap: () => ({ message: 'Choose your property type.' }),
  }),
});

router.patch(
  '/profile',
  validate(addressSchema),
  asyncHandler(async (req, res) => {
    const input = req.body;
    const user = await User.findById(req.user.sub);
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');

    const property = await lookupCouncilTaxBand(
      {
        fulladdress: `${input.addressLine}, ${input.city}`,
        postcode: input.postcode,
      },
      { allowPostcodeOnly: true },
    );

    const previousBand = user.councilTaxBand;
    user.addressLine = input.addressLine;
    user.city = input.city;
    user.postcode = input.postcode;
    user.postcodeNormalised = normalisePostcode(input.postcode);
    user.propertyType = input.propertyType;
    user.councilTaxBand = property?.councilTaxBand ?? null;
    await user.save();

    const awarded = await awardCouncilPaymentIfDue(user);

    res.json({
      profile: user.toJSON(),
      councilPaymentAwarded: awarded ? awarded.amount : 0,
      bandChanged: previousBand !== user.councilTaxBand,
      message: awarded
        ? `Address updated. Council Tax band ${user.councilTaxBand} — £${awarded.amount.toFixed(2)} Council payment added to your energy credit.`
        : property
          ? `Address updated. Council Tax band ${user.councilTaxBand}.`
          : 'Address updated. We could not match it to a Council Tax band.',
    });
  }),
);

/* ------------------------------------------------------------------------ */
/* Email (the login ID)                                                     */
/* ------------------------------------------------------------------------ */

const emailRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your current password.'),
});

router.post(
  '/profile/email',
  validate(emailRequestSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findById(req.user.sub).select('+passwordHash');
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');

    // The current password is required: an unattended session should not be enough to move the account to someone else's inbox.
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw badRequest('INVALID_PASSWORD', 'That password is not correct.', 'password');
    }
    if (email === user.email) {
      throw badRequest('SAME_EMAIL', 'That is already your email address.', 'email');
    }
    if (await User.findOne({ email })) {
      throw conflict('EMAIL_ALREADY_REGISTERED', 'That email is already in use.', 'email');
    }

    const result = await issueEmailChangeCode(user, email, { enforceCooldown: true });
    res.json({
      sent: true,
      pendingEmail: email,
      delivery: result.send,
      expiresInMinutes: result.expiresInMinutes,
      resendSeconds: config.otp.resendSeconds,
      ...(result.devCode ? { devCode: result.devCode } : {}),
      message: `We sent a 6-digit code to ${email}.`,
    });
  }),
);

const emailVerifySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

router.post(
  '/profile/email/verify',
  validate(emailVerifySchema),
  asyncHandler(async (req, res) => {
    const record = await EmailVerification.findOne({
      userId: req.user.sub,
      purpose: 'email_change',
    });
    if (!record) {
      throw badRequest('CODE_NOT_FOUND', 'Ask for a new code and try again.', 'code');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await record.deleteOne();
      throw badRequest('CODE_EXPIRED', 'That code has expired. Ask for a new one.', 'code');
    }
    if (record.attempts >= config.otp.maxAttempts) {
      await record.deleteOne();
      throw badRequest('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.', 'code');
    }

    if (!verifyRawCode(req.body.code, record.codeHash)) {
      record.attempts += 1;
      await record.save();
      const left = config.otp.maxAttempts - record.attempts;
      throw badRequest(
        'INVALID_CODE',
        `That code is not right. ${left} attempt${left === 1 ? '' : 's'} remaining.`,
        'code',
      );
    }

    // Re-check uniqueness: someone else may have registered it while the code was in flight.
    if (await User.findOne({ email: record.email })) {
      await record.deleteOne();
      throw conflict('EMAIL_ALREADY_REGISTERED', 'That email is now in use.', 'email');
    }

    const user = await User.findById(req.user.sub);
    user.email = record.email;
    user.emailVerified = true;
    await user.save();
    await record.deleteOne();

    res.json({
      profile: user.toJSON(),
      // The email is part of the token payload, so it has to be reissued.
      token: signToken(sessionPayload(user)),
      message: 'Your email address has been changed.',
    });
  }),
);

/* ------------------------------------------------------------------------ */
/* Password                                                                 */
/* ------------------------------------------------------------------------ */

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z
    .string()
    .min(8, 'Use at least 8 characters.')
    .max(128)
    .regex(/[A-Za-z]/, 'Include at least one letter.')
    .regex(/\d/, 'Include at least one number.'),
});

router.post(
  '/profile/password',
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.sub).select('+passwordHash');
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('INVALID_PASSWORD', 'That password is not correct.', 'currentPassword');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw badRequest(
        'SAME_PASSWORD',
        'Your new password must be different from the current one.',
        'newPassword',
      );
    }

    user.passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    // Stamping this invalidates every token issued before now, so changing the password signs out every other device — the point of changing it.
    user.passwordChangedAt = new Date();
    await user.save();
    await EmailVerification.deleteMany({ userId: user._id });

    res.json({
      token: signToken(sessionPayload(user)),
      message: 'Password changed. Any other devices have been signed out.',
    });
  }),
);

/* ------------------------------------------------------------------------ */
/* Notification preferences                                                 */
/* ------------------------------------------------------------------------ */

const prefsSchema = z.object({
  newBill: z.boolean().optional(),
  paymentReceipt: z.boolean().optional(),
  lowCredit: z.boolean().optional(),
  lowCreditThreshold: z.number().min(0).max(10000).optional(),
});

router.patch(
  '/profile/notifications',
  validate(prefsSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.sub);
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    const current = user.notificationPrefs?.toObject?.() ?? user.notificationPrefs ?? {};
    user.notificationPrefs = { ...current, ...req.body };
    await user.save();
    res.json({
      notificationPrefs: user.notificationPrefs,
      message: 'Notification settings saved.',
    });
  }),
);

/* ------------------------------------------------------------------------ */
/* In-app notifications                                                       */
/* ------------------------------------------------------------------------ */

router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const [items, unread] = await Promise.all([
      Notification.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50).exec(),
      Notification.countDocuments({ userId: req.user.sub, readAt: null }),
    ]);
    res.json({
      notifications: items.map((n) => n.toJSON()),
      unread,
    });
  }),
);

router.post(
  '/notifications/read',
  asyncHandler(async (req, res) => {
    await Notification.updateMany(
      { userId: req.user.sub, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.json({ unread: 0, message: 'All notifications marked as read.' });
  }),
);

/* ------------------------------------------------------------------------ */
/* Export and delete                                                        */
/* ------------------------------------------------------------------------ */

router.get(
  '/profile/export',
  asyncHandler(async (req, res) => {
    const id = req.user.sub;
    const [user, readings, bills, payments, notifications] = await Promise.all([
      User.findById(id).lean(),
      MeterReading.find({ userId: id }).sort({ readingDate: 1 }).lean(),
      Bill.find({ userId: id }).sort({ periodEnd: 1 }).lean(),
      Payment.find({ userId: id }).sort({ createdAt: 1 }).lean(),
      Notification.find({ userId: id }).sort({ createdAt: 1 }).lean(),
    ]);
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    delete user.passwordHash;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="myslp-my-data.json"');
    res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          service: 'MySLP — Shangri-La Power',
          account: user,
          meterReadings: readings,
          bills,
          payments,
          notifications,
        },
        null,
        2,
      ),
    );
  }),
);

const deleteSchema = z.object({
  password: z.string().min(1, 'Enter your password to confirm.'),
  confirm: z.literal('DELETE', {
    errorMap: () => ({ message: 'Type DELETE to confirm.' }),
  }),
});

router.delete(
  '/profile',
  validate(deleteSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.sub).select('+passwordHash');
    if (!user) throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    if (user.role === 'admin') {
      throw badRequest('ADMIN_CANNOT_DELETE', 'An administrator account cannot be deleted here.');
    }
    if (!(await bcrypt.compare(req.body.password, user.passwordHash))) {
      throw badRequest('INVALID_PASSWORD', 'That password is not correct.', 'password');
    }

    // An account cannot be closed while it owes money. 
    const unpaid = await Bill.find({ userId: user._id, status: 'unpaid' }).lean();
    if (unpaid.length > 0) {
      const owed = unpaid.reduce((sum, b) => sum + b.totalAmount, 0);
      throw conflict(
        'UNPAID_BILLS',
        `You still have ${unpaid.length} unpaid bill${unpaid.length === 1 ? '' : 's'} totalling £${owed.toFixed(2)}. Settle them before closing your account.`,
      );
    }

    const id = user._id;
    // Everything owed is settled by this point. Vouchers are deliberately not touched: a redeemed voucher is a record of the Council's money.
    await Promise.all([
      MeterReading.deleteMany({ userId: id }),
      Bill.deleteMany({ userId: id }),
      Payment.deleteMany({ userId: id }),
      Notification.deleteMany({ userId: id }),
      EmailVerification.deleteMany({ userId: id }),
    ]);
    await user.deleteOne();

    res.json({ deleted: true, message: 'Your account and its data have been deleted.' });
  }),
);

export default router;
