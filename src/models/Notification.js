import mongoose, { Schema } from 'mongoose';

//An in-app notification: the entries behind the bell in the header.

export const NOTIFICATION_TYPES = ['new_bill', 'payment_receipt', 'low_credit', 'council_payment'];

const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: NOTIFICATION_TYPES,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    /** Where the bell entry links to, e.g. /bills. */
    link: {
      type: String,
      default: null,
    },
    /** Null until opened. Used for the unread count on the bell. */
    readAt: {
      type: Date,
      default: null,
    },
    /** Whether an email went out as well, so the UI can say so honestly. */
    emailed: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** The bell lists newest first, for one user. */
notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification =
  mongoose.models.Notification ?? mongoose.model('Notification', notificationSchema);
