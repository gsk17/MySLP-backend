import mongoose, { Schema } from 'mongoose';
const meterReadingSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    readingDate: {
      type: Date,
      required: true,
    },
    electricityDay: {
      type: Number,
      required: true,
      min: 0,
    },
    electricityNight: {
      type: Number,
      required: true,
      min: 0,
    },
    gas: {
      type: Number,
      required: true,
      min: 0,
    },
    isBaseline: {
      type: Boolean,
      required: true,
      default: false,
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
meterReadingSchema.index({
  userId: 1,
  readingDate: -1,
});
export const MeterReading =
  mongoose.models.MeterReading ?? mongoose.model('MeterReading', meterReadingSchema);
