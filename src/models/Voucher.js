import mongoose, { Schema } from 'mongoose';
/**
 * Energy Support Scheme Vouchers. Redemption is a single atomic
 * findOneAndUpdate on { code, redeemed: false } so a code can never be
 * redeemed twice, even under concurrent requests.
 */
const voucherSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    value: {
      type: Number,
      required: true,
      default: 200,
    },
    redeemed: {
      type: Boolean,
      required: true,
      default: false,
    },
    redeemedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    redeemedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);
export const Voucher = mongoose.models.Voucher ?? mongoose.model('Voucher', voucherSchema);
