import mongoose, { Schema } from 'mongoose';
import { config } from '../config.js';
export const PROPERTY_TYPES = [
  'detached',
  'semi-detached',
  'terraced',
  'flat',
  'cottage',
  'bungalow',
  'mansion',
];
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // select:false keeps the hash out of every query result by default.
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    addressLine: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      default: 'Shangri-La',
    },
    postcode: {
      type: String,
      required: true,
      trim: true,
    },
    postcodeNormalised: {
      type: String,
      required: true,
      index: true,
    },
    propertyType: {
      type: String,
      required: true,
      enum: PROPERTY_TYPES,
    },
    councilTaxBand: {
      type: String,
      default: null,
      uppercase: true,
      maxlength: 1,
    },
    role: {
      type: String,
      required: true,
      enum: ['customer', 'admin'],
      default: 'customer',
    },
    // Set by the one-time code emailed at registration. Sign-in is refused
    // until it is true.
    emailVerified: {
      type: Boolean,
      required: true,
      default: false,
    },
    /**
     * When the password last changed. Tokens issued before this are rejected,
     * so resetting a password ends every other session — otherwise someone who
     * already holds a token keeps their access after the reset.
     */
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    energyCredit: {
      type: Number,
      required: true,
      default: config.startingEnergyCredit,
    },
    /**
     * When the Council's £200 cost-of-living payment was credited.
     *
     * Stored on the user rather than inferred from the band, because the band
     * can change: someone who moves from band C to band E keeps the money
     * they were already paid, and must not be paid a second time if they
     * later move back.
     */
    councilPaymentPaidAt: {
      type: Date,
      default: null,
    },
    /**
     * Which events this customer wants emailed. In-app notifications are
     * always recorded — they cost nothing and the bell can be ignored — but an
     * email is an interruption, so each one is opt-out individually.
     */
    notificationPrefs: {
      newBill: { type: Boolean, default: true },
      paymentReceipt: { type: Boolean, default: true },
      lowCredit: { type: Boolean, default: true },
      /** Balance at or below which the low-credit warning fires, in pounds. */
      lowCreditThreshold: { type: Number, default: 50, min: 0, max: 10000 },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);
userSchema.index({
  councilTaxBand: 1,
  postcodeNormalised: 1,
});
export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
