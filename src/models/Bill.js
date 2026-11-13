import mongoose, { Schema } from 'mongoose';
const billSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    readingId: {
      type: Schema.Types.ObjectId,
      ref: 'MeterReading',
      required: true,
    },
    previousReadingId: {
      type: Schema.Types.ObjectId,
      ref: 'MeterReading',
      required: true,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    days: {
      type: Number,
      required: true,
      min: 0,
    },
    dayKwh: {
      type: Number,
      required: true,
    },
    nightKwh: {
      type: Number,
      required: true,
    },
    gasKwh: {
      type: Number,
      required: true,
    },
    dayCost: {
      type: Number,
      required: true,
    },
    nightCost: {
      type: Number,
      required: true,
    },
    gasCost: {
      type: Number,
      required: true,
    },
    standingCost: {
      type: Number,
      required: true,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['unpaid', 'paid'],
      default: 'unpaid',
    },
    paidAt: {
      type: Date,
      default: null,
    },
    tariffId: {
      type: Schema.Types.ObjectId,
      ref: 'Tariff',
      required: true,
    },
    // Snapshot so a later tariff change never rewrites history.
    tariffSnapshot: {
      electricityDayRate: {
        type: Number,
        required: true,
      },
      electricityNightRate: {
        type: Number,
        required: true,
      },
      gasRate: {
        type: Number,
        required: true,
      },
      standingChargePerDay: {
        type: Number,
        required: true,
      },
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
billSchema.index({
  userId: 1,
  status: 1,
  periodEnd: 1,
});
export const Bill = mongoose.models.Bill ?? mongoose.model('Bill', billSchema);
