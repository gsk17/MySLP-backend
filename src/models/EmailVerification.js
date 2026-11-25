import mongoose, { Schema } from 'mongoose';

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

emailVerificationSchema.index({ userId: 1, purpose: 1 }, { unique: true });

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerification =
  mongoose.models.EmailVerification ?? mongoose.model('EmailVerification', emailVerificationSchema);
