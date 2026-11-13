import mongoose, { Schema } from 'mongoose';
const paymentSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    billId: {
      type: Schema.Types.ObjectId,
      ref: 'Bill',
      default: null,
    },
    voucherCode: {
      type: String,
      default: null,
    },
    type: {
      type: String,
      required: true,
      enum: ['bill_payment', 'voucher_topup', 'council_payment'],
    },
    // Positive for a top-up or the Council payment, negative for a bill.
    amount: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
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
paymentSchema.index({
  userId: 1,
  createdAt: -1,
});
export const Payment = mongoose.models.Payment ?? mongoose.model('Payment', paymentSchema);
