import mongoose, { Schema } from 'mongoose';
//Tariffs are APPEND-ONLY. Setting new prices inserts a new document; existing rows are never updated, so historic bills can always be explained.

const tariffSchema = new Schema(
  {
    electricityDayRate: {
      type: Number,
      required: true,
      min: 0,
    },
    electricityNightRate: {
      type: Number,
      required: true,
      min: 0,
    },
    gasRate: {
      type: Number,
      required: true,
      min: 0,
    },
    standingChargePerDay: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    effectiveFrom: {
      type: Date,
      required: true,
      default: () => new Date(),
      index: -1,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
export const Tariff = mongoose.models.Tariff ?? mongoose.model('Tariff', tariffSchema);

// The tariff in effect right now: newest document with effectiveFrom <= now.
export async function getActiveTariff() {
  const tariff = await Tariff.findOne({
    effectiveFrom: {
      $lte: new Date(),
    },
  })
    .sort({
      effectiveFrom: -1,
      createdAt: -1,
    })
    .exec();
  if (!tariff) {
    throw new Error('No tariff configured. Run `npm run seed` to create the initial tariff.');
  }
  return tariff;
}
