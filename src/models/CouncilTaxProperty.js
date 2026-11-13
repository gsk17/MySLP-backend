import mongoose, { Schema } from 'mongoose';
const councilTaxPropertySchema = new Schema(
  {
    fullAddress: {
      type: String,
      required: true,
      trim: true,
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
    addressNormalised: {
      type: String,
      required: true,
      index: true,
    },
    councilTaxBand: {
      type: String,
      required: true,
      uppercase: true,
      maxlength: 1,
    },
  },
  {
    timestamps: false,
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
councilTaxPropertySchema.index({
  addressNormalised: 1,
  postcodeNormalised: 1,
});
export const CouncilTaxProperty =
  mongoose.models.CouncilTaxProperty ??
  mongoose.model('CouncilTaxProperty', councilTaxPropertySchema);
