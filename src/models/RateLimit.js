import mongoose, { Schema } from 'mongoose';

/**
 * One fixed rate-limiting window, shared by every instance of the API.
 *
 * The counter has to live outside the process. On Vercel each serverless
 * invocation may run in a different instance with its own memory, and a cold
 * start wipes it — so an in-memory counter limits per-instance rather than
 * globally, which is barely a limit at all. Keeping it in MongoDB means every
 * instance increments the same number.
 */
const rateLimitSchema = new Schema(
  {
    /** `<ip>:<route>` — one window per caller per endpoint. */
    _id: {
      type: String,
    },
    count: {
      type: Number,
      required: true,
      default: 0,
    },
    /** When this window ends. Also drives the TTL sweep. */
    resetAt: {
      type: Date,
      required: true,
    },
  },
  {
    versionKey: false,
    // The documents are tiny and short-lived; timestamps would double the
    // write size for nothing.
    timestamps: false,
  },
);

/**
 * MongoDB deletes each window once it expires, so the collection stays small
 * without a sweeper. The background task runs about once a minute, which is
 * why the limiter checks `resetAt` itself rather than trusting absence.
 */
rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = mongoose.models.RateLimit ?? mongoose.model('RateLimit', rateLimitSchema);
