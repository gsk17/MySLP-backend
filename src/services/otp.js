import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { EmailVerification } from '../models/EmailVerification.js';
import { User } from '../models/User.js';
import { sendVerificationEmail, sendPasswordResetEmail } from './mailer.js';
import { badRequest, conflict, notFound, tooManyRequests } from '../utils/errors.js';



const DIGITS = 6;
const MAX = 10 ** DIGITS;

/** Unbiased 6-digit code. Rejection sampling avoids the modulo skew of `% 10**6`. */
function generateCode() {
  const limit = Math.floor(0xff_ff_ff_ff / MAX) * MAX;
  let value;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % MAX).padStart(DIGITS, '0');
}

function hashCode(code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(code).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}


export function verifyRawCode(code, codeHash) {
  return safeEqual(hashCode(String(code)), codeHash);
}


async function issueCode(user, purpose, send, options = {}) {
  // `options.email` targets an address the user does not hold yet, used by the change-of-address flow. Everything else sends to the account's address.
  const target = options.email ?? user.email;
  if (options.enforceCooldown) {
    const existing = await EmailVerification.findOne({ userId: user._id, purpose });
    if (existing) {
      const waited = (Date.now() - existing.lastSentAt.getTime()) / 1000;
      const remaining = Math.ceil(config.otp.resendSeconds - waited);
      if (remaining > 0) {
        throw tooManyRequests(
          `Please wait ${remaining} second${remaining === 1 ? '' : 's'} before requesting another code.`,
        );
      }
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60_000);

  await EmailVerification.findOneAndUpdate(
    { userId: user._id, purpose },
    {
      $set: {
        userId: user._id,
        purpose,
        email: target,
        codeHash: hashCode(code),
        expiresAt,
        attempts: 0,
        lastSentAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  const result = await send(target, user.fullName, code, config.otp.ttlMinutes);

  return {
    send: result,
    expiresInMinutes: config.otp.ttlMinutes,
    ...(config.isProd ? {} : { devCode: code }),
  };
}

export function issueVerificationCode(user, options = {}) {
  return issueCode(user, 'email_verification', sendVerificationEmail, options);
}

export function issuePasswordResetCode(user, options = {}) {
  return issueCode(user, 'password_reset', sendPasswordResetEmail, options);
}


export function issueEmailChangeCode(user, newEmail, options = {}) {
  return issueCode(user, 'email_change', sendVerificationEmail, { ...options, email: newEmail });
}


async function consumeCode(user, code, purpose) {
  const record = await EmailVerification.findOne({ userId: user._id, purpose });
  if (!record) {
    throw badRequest(
      'CODE_NOT_FOUND',
      'That code has expired. Request a new one to continue.',
      'code',
    );
  }

  // Belt and braces: the TTL sweeper only runs about once a minute.
  if (record.expiresAt.getTime() <= Date.now()) {
    await EmailVerification.deleteOne({ _id: record._id });
    throw badRequest('CODE_EXPIRED', 'That code has expired. Request a new one.', 'code');
  }

  if (record.attempts >= config.otp.maxAttempts) {
    await EmailVerification.deleteOne({ _id: record._id });
    throw tooManyRequests('Too many incorrect codes. Request a new one to continue.');
  }

  if (!safeEqual(record.codeHash, hashCode(String(code).trim()))) {
    const updated = await EmailVerification.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    const left = Math.max(
      0,
      config.otp.maxAttempts - (updated?.attempts ?? config.otp.maxAttempts),
    );
    if (left === 0) {
      await EmailVerification.deleteOne({ _id: record._id });
      throw tooManyRequests('Too many incorrect codes. Request a new one to continue.');
    }
    throw badRequest(
      'INVALID_CODE',
      `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} remaining.`,
      'code',
    );
  }

  await EmailVerification.deleteOne({ _id: record._id });
}

// Confirm a new address and mark the account verified. 
export async function verifyCode(email, code) {
  const user = await User.findOne({ email });
  if (!user) {
    throw notFound('USER_NOT_FOUND', 'No account was found for that email address.');
  }
  if (user.emailVerified) {
    throw conflict('ALREADY_VERIFIED', 'This email address has already been verified.');
  }

  await consumeCode(user, code, 'email_verification');

  user.emailVerified = true;
  await user.save();
  return user;
}


export async function resetPasswordWithCode(email, code, newPassword) {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    throw notFound('USER_NOT_FOUND', 'No account was found for that email address.');
  }

  await consumeCode(user, code, 'password_reset');

  user.passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  user.passwordChangedAt = new Date();
  user.emailVerified = true;
  await user.save();

  // Any outstanding sign-up code is now moot.
  await EmailVerification.deleteMany({ userId: user._id });

  return user;
}

// Discards any outstanding codes, e.g. when an unverified signup is replaced. 
export async function clearVerification(userId) {
  await EmailVerification.deleteMany({ userId });
}
