import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { User, PROPERTY_TYPES } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken, sessionPayload } from '../middleware/auth.js';
import { loginLimiter, publicApiLimiter } from '../middleware/rateLimit.js';
import { ApiError, badRequest, conflict, unauthorized, notFound } from '../utils/errors.js';
import { normaliseEmail, normalisePostcode, normaliseAddress } from '../utils/normalise.js';
import { lookupCouncilTaxBand } from '../services/councilTax.js';
import { awardCouncilPaymentIfDue } from '../services/councilPayment.js';
import {
  issueVerificationCode,
  issuePasswordResetCode,
  verifyCode,
  resetPasswordWithCode,
} from '../services/otp.js';
import { mailMode } from '../services/mailer.js';
const router = Router();

/** A hash of a throwaway password, compared against when an email is unknown,
 *  so a failed login takes the same time whether or not the account exists. */
const DUMMY_HASH = bcrypt.hashSync('myslp-dummy-password-for-timing', 10);
const emailSchema = z
  .string({
    required_error: 'Enter your email address.',
  })
  .trim()
  .min(1, 'Enter your email address.')
  .email('Enter a valid email address.')
  .transform(normaliseEmail);
const passwordSchema = z
  .string({
    required_error: 'Enter a password.',
  })
  .min(8, 'Your password must be at least 8 characters long.')
  .max(128, 'That password is too long.')
  .regex(/[a-z]/, 'Your password must include a lowercase letter.')
  .regex(/[A-Z]/, 'Your password must include an uppercase letter.')
  .regex(/[0-9]/, 'Your password must include a number.');
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  addressLine: z.string().trim().min(3, 'Enter your address.').max(200),
  city: z.string().trim().min(2, 'Enter your town or city.').max(80).default('Shangri-La'),
  postcode: z.string().trim().min(3, 'Enter your postcode.').max(12),
  propertyType: z.enum(PROPERTY_TYPES, {
    errorMap: () => ({
      message: 'Choose your property type.',
    }),
  }),
});
const loginSchema = z.object({
  email: z
    .string({
      required_error: 'Enter your email address.',
    })
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.')
    .transform(normaliseEmail),
  password: z
    .string({
      required_error: 'Enter your password.',
    })
    .min(1, 'Enter your password.'),
});
function publicUser(user) {
  return {
    id: user._id,
    email: user.email,
    fullName: user.fullName,
    addressLine: user.addressLine,
    city: user.city,
    postcode: user.postcode,
    propertyType: user.propertyType,
    councilTaxBand: user.councilTaxBand,
    role: user.role,
    emailVerified: user.emailVerified,
    energyCredit: user.energyCredit,
    // Exposed so the app can say "received" rather than "eligible" once the
    // Council payment has actually been credited.
    councilPaymentPaidAt: user.councilPaymentPaidAt ?? null,
    createdAt: user.createdAt,
  };
}

/** Bands A-D qualify for the Shangri-La Council's £200 payment. */
function isCouncilPaymentEligible(band) {
  return !!band && ['A', 'B', 'C', 'D'].includes(band.toUpperCase());
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post(
  '/register',
  publicApiLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const input = req.body;
    const existing = await User.findOne({
      email: input.email,
    });
    if (existing) {
      throw conflict(
        'EMAIL_ALREADY_REGISTERED',
        'This email address is already associated with an existing account.',
        'email',
      );
    }
    const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);

    // Attach the council tax band automatically where the address is known.
    const property = await lookupCouncilTaxBand(
      {
        fulladdress: `${input.addressLine}, ${input.city}`,
        postcode: input.postcode,
      },
      // The app's own form: a real postcode with a flat number or an
      // unregistered town should still find its property.
      { allowPostcodeOnly: true },
    );
    const user = await User.create({
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      addressLine: input.addressLine,
      city: input.city,
      postcode: input.postcode,
      postcodeNormalised: normalisePostcode(input.postcode),
      propertyType: input.propertyType,
      councilTaxBand: property?.councilTaxBand ?? null,
      role: 'customer',
      energyCredit: config.startingEnergyCredit,
    });

    // Bands A-D get the Council's cost-of-living payment on top of the £500
    // every account opens with.
    await awardCouncilPaymentIfDue(user);

    // No token yet: the account is inert until the emailed code is entered.
    const issued = await issueVerificationCode(user);
    res.status(201).json({
      requiresVerification: true,
      email: user.email,
      expiresInMinutes: issued.expiresInMinutes,
      resendSeconds: config.otp.resendSeconds,
      delivery: issued.send.mode,
      ...(issued.send.previewUrl
        ? {
            previewUrl: issued.send.previewUrl,
          }
        : {}),
      ...(issued.devCode
        ? {
            devCode: issued.devCode,
          }
        : {}),
      user: publicUser(user),
      councilPaymentEligible: isCouncilPaymentEligible(user.councilTaxBand),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email — exchange the one-time code for a session
// ---------------------------------------------------------------------------
const verifySchema = z.object({
  email: emailSchema,
  code: z
    .string({
      required_error: 'Enter the code from your email.',
    })
    .trim()
    .regex(/^\d{6}$/, 'The code is 6 digits.'),
});
router.post(
  '/verify-email',
  publicApiLimiter,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    const user = await verifyCode(email, code);
    const token = signToken(sessionPayload(user));
    res.json({
      token,
      user: publicUser(user),
      councilPaymentEligible: isCouncilPaymentEligible(user.councilTaxBand),
      message: 'Email verified. Welcome to MySLP.',
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/resend-code
// ---------------------------------------------------------------------------
const resendSchema = z.object({
  email: emailSchema,
});
router.post(
  '/resend-code',
  publicApiLimiter,
  validate(resendSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({
      email,
    });

    // Do not reveal whether the address exists; just report success.
    if (!user || user.emailVerified) {
      res.json({
        sent: true,
        resendSeconds: config.otp.resendSeconds,
      });
      return;
    }
    const issued = await issueVerificationCode(user, {
      enforceCooldown: true,
    });
    res.json({
      sent: true,
      expiresInMinutes: issued.expiresInMinutes,
      resendSeconds: config.otp.resendSeconds,
      delivery: issued.send.mode,
      ...(issued.send.previewUrl
        ? {
            previewUrl: issued.send.previewUrl,
          }
        : {}),
      ...(issued.devCode
        ? {
            devCode: issued.devCode,
          }
        : {}),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — email a reset code
//
// Always answers 200 with the same body. Saying "no such account" here would
// turn the endpoint into a membership oracle: anybody could test an address
// and learn whether it is registered.
// ---------------------------------------------------------------------------
const forgotSchema = z.object({ email: emailSchema });

router.post(
  '/forgot-password',
  loginLimiter,
  validate(forgotSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      res.json({ sent: true, resendSeconds: config.otp.resendSeconds });
      return;
    }

    const issued = await issuePasswordResetCode(user, { enforceCooldown: true });

    res.json({
      sent: true,
      expiresInMinutes: issued.expiresInMinutes,
      resendSeconds: config.otp.resendSeconds,
      delivery: issued.send.mode,
      ...(issued.send.previewUrl ? { previewUrl: issued.send.previewUrl } : {}),
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password — exchange the code for a new password
// ---------------------------------------------------------------------------
const resetSchema = z.object({
  email: emailSchema,
  code: z
    .string({ required_error: 'Enter the code from your email.' })
    .trim()
    .regex(/^\d{6}$/, 'The code is 6 digits.'),
  password: passwordSchema,
});

router.post(
  '/reset-password',
  publicApiLimiter,
  validate(resetSchema),
  asyncHandler(async (req, res) => {
    const { email, code, password } = req.body;
    const user = await resetPasswordWithCode(email, code, password);

    // Signed straight in: they have just proved both mailbox control and
    // knowledge of the new password, so a second sign-in step adds nothing.
    const token = signToken(sessionPayload(user));

    res.json({
      token,
      user: publicUser(user),
      councilPaymentEligible: isCouncilPaymentEligible(user.councilTaxBand),
      message: 'Password changed. You are signed in.',
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/mail-status — lets the UI warn when email is not configured
// ---------------------------------------------------------------------------
router.get('/mail-status', (_req, res) => {
  res.json({
    mode: mailMode(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({
      email,
    }).select('+passwordHash');

    // Always run a comparison so response timing cannot be used to tell
    // an unknown email apart from a wrong password.
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !matches) {
      throw unauthorized('The email address or password is incorrect.', 'INVALID_CREDENTIALS');
    }

    // Correct password, but the address was never confirmed. A distinct code
    // lets the client send them straight to the code screen.
    if (!user.emailVerified) {
      throw new ApiError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Confirm your email address to finish setting up your account.',
      );
    }
    const token = signToken(sessionPayload(user));
    res.json({
      token,
      user: publicUser(user),
      councilPaymentEligible: isCouncilPaymentEligible(user.councilTaxBand),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/check-email  — powers the live "already registered" hint
// ---------------------------------------------------------------------------
router.get(
  '/check-email',
  publicApiLimiter,
  asyncHandler(async (req, res) => {
    const raw = typeof req.query.email === 'string' ? req.query.email : '';
    const parsed = z.string().email().safeParse(raw.trim());
    if (!parsed.success) {
      throw badRequest('INVALID_EMAIL_FORMAT', 'Enter a valid email address.', 'email');
    }
    const exists = await User.exists({
      email: normaliseEmail(parsed.data),
    });
    res.json({
      available: !exists,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/check-address — live council tax band preview on the form
// ---------------------------------------------------------------------------
router.get(
  '/check-address',
  publicApiLimiter,
  asyncHandler(async (req, res) => {
    const fulladdress = typeof req.query.fulladdress === 'string' ? req.query.fulladdress : '';
    const postcode = typeof req.query.postcode === 'string' ? req.query.postcode : '';
    if (!normaliseAddress(fulladdress) && !normalisePostcode(postcode)) {
      throw badRequest('MISSING_PARAMETERS', 'Provide an address or a postcode to look up.');
    }
    // The live preview on the sign-up form, so it must agree with what
    // registration itself will decide.
    const property = await lookupCouncilTaxBand(
      { fulladdress, postcode },
      { allowPostcodeOnly: true },
    );
    res.json({
      found: !!property,
      address: property?.fullAddress ?? null,
      councilTaxBand: property?.councilTaxBand ?? null,
      councilPaymentEligible: isCouncilPaymentEligible(property?.councilTaxBand ?? null),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.sub);
    if (!user) {
      throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    }
    res.json({
      user: publicUser(user),
      councilPaymentEligible: isCouncilPaymentEligible(user.councilTaxBand),
    });
  }),
);
export default router;
