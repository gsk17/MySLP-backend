import mongoose, { Schema } from 'mongoose';

/**
 * One-time codes emailed to a user.
 *
 * `purpose` separates the two flows: confirming a new address and resetting a
 * forgotten password. Without it a pending sign-up code and a reset code would
 * overwrite one another, since there is at most one live code per user.
 */
export const OTP_PURPOSES = ['email_verification', 'password_reset', 'email_change'];

const emailVerificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      required: true,
      enum: OTP_PURPOSES,
      default: 'email_verification',
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    /**
     * The address the code was sent to. For 'email_change' this is the NEW
     * address, which is not yet on the user — that is the whole point of the
     * flow, and it is what the code is proving control of.
     */
    /** SHA-256 HMAC of the code. The plaintext is never stored. */
    codeHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
    },
    lastSentAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/** At most one live code per user per flow. */
emailVerificationSchema.index({ userId: 1, purpose: 1 }, { unique: true });

/**
 * MongoDB deletes the document once expiresAt passes, so expired codes clean
 * themselves up and a stale code can never be replayed. The sweeper runs about
 * once a minute, so verification ALSO checks expiresAt explicitly rather than
 * trusting the document's absence.
 */
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerification =
  mongoose.models.EmailVerification ?? mongoose.model('EmailVerification', emailVerificationSchema);
