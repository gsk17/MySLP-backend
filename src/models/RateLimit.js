import mongoose, { Schema } from 'mongoose';

const rateLimitSchema = new Schema(
  {
    //<ip>:<route>` — one window per caller per endpoint.
    _id: {
      type: String,
    },
    count: {
      type: Number,
      required: true,
      default: 0,
    },
    //When this window ends. Also drives the TTL sweep.
    resetAt: {
      type: Date,
      required: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = mongoose.models.RateLimit ?? mongoose.model('RateLimit', rateLimitSchema);
