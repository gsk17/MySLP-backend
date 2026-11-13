import mongoose from 'mongoose';
import { Bill } from '../models/Bill.js';
import { Payment } from '../models/Payment.js';
import { User } from '../models/User.js';
import { Voucher } from '../models/Voucher.js';
import { supportsTransactions } from '../db.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { normaliseVoucherCode, round2 } from '../utils/normalise.js';

/**
 * Pay a bill from the customer's energy credit.
 *
 * Guards: the bill must belong to this customer, be unpaid, be the oldest
 * unpaid bill, and be covered by the balance. All writes happen together.
 */
export async function payBill(userId, billId) {
  const bill = await Bill.findOne({
    _id: billId,
    userId,
  });
  if (!bill) {
    throw notFound('BILL_NOT_FOUND', 'That bill could not be found on your account.');
  }
  if (bill.status === 'paid') {
    throw conflict('BILL_ALREADY_PAID', 'This bill has already been paid.');
  }
  const older = await Bill.findOne({
    userId,
    status: 'unpaid',
    periodEnd: {
      $lt: bill.periodEnd,
    },
  })
    .sort({
      periodEnd: 1,
    })
    .exec();
  if (older) {
    throw conflict('OLDER_BILL_UNPAID', 'Please pay your oldest unpaid bill first.');
  }
  const user = await User.findById(userId);
  if (!user) {
    throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
  }
  if (user.energyCredit < bill.totalAmount) {
    const shortfall = round2(bill.totalAmount - user.energyCredit);
    throw badRequest(
      'INSUFFICIENT_CREDIT',
      `You need £${shortfall.toFixed(2)} more to pay this bill. Top up with an ESSV voucher to continue.`,
    );
  }
  const newBalance = round2(user.energyCredit - bill.totalAmount);
  const apply = async (session) => {
    const opts = session
      ? {
          session,
        }
      : {};

    // Conditional update: re-checks status and balance at write time, so two
    // concurrent requests cannot both pay the same bill.
    const updatedBill = await Bill.findOneAndUpdate(
      {
        _id: bill._id,
        userId,
        status: 'unpaid',
      },
      {
        $set: {
          status: 'paid',
          paidAt: new Date(),
        },
      },
      {
        new: true,
        ...opts,
      },
    );
    if (!updatedBill) {
      throw conflict('BILL_ALREADY_PAID', 'This bill has already been paid.');
    }
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        energyCredit: {
          $gte: bill.totalAmount,
        },
      },
      {
        $inc: {
          energyCredit: -bill.totalAmount,
        },
      },
      {
        new: true,
        ...opts,
      },
    );
    if (!updatedUser) {
      throw badRequest('INSUFFICIENT_CREDIT', 'Your energy credit no longer covers this bill.');
    }
    await Payment.create(
      [
        {
          userId,
          billId: bill._id,
          type: 'bill_payment',
          amount: -bill.totalAmount,
          balanceAfter: round2(updatedUser.energyCredit),
        },
      ],
      opts,
    );
    return {
      bill: updatedBill,
      energyCredit: round2(updatedUser.energyCredit),
    };
  };
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await apply(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
  void newBalance;
  return apply();
}

/**
 * Redeem an ESSV voucher.
 *
 * The claim is a single atomic findOneAndUpdate on { code, redeemed: false }.
 * If it returns null we re-query by code to tell "not found" apart from
 * "already redeemed" — the two errors the coursework requires separately.
 */
export async function redeemVoucher(userId, rawCode) {
  const code = normaliseVoucherCode(rawCode);
  if (!code) {
    throw badRequest('VOUCHER_CODE_REQUIRED', 'Enter a voucher code to continue.', 'code');
  }
  const claim = async (session) => {
    const opts = session
      ? {
          session,
        }
      : {};
    const voucher = await Voucher.findOneAndUpdate(
      {
        code,
        redeemed: false,
      },
      {
        $set: {
          redeemed: true,
          redeemedBy: userId,
          redeemedAt: new Date(),
        },
      },
      {
        new: true,
        ...opts,
      },
    );
    if (!voucher) {
      const existing = await Voucher.findOne({
        code,
      }).session(session ?? null);
      if (!existing) {
        throw notFound('VOUCHER_NOT_FOUND', 'This voucher code was not found.');
      }
      throw conflict('VOUCHER_ALREADY_REDEEMED', 'This voucher has already been redeemed.', 'code');
    }
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          energyCredit: voucher.value,
        },
      },
      {
        new: true,
        ...opts,
      },
    );
    if (!updatedUser) {
      throw notFound('USER_NOT_FOUND', 'Your account could not be found.');
    }
    const energyCredit = round2(updatedUser.energyCredit);
    await Payment.create(
      [
        {
          userId,
          billId: null,
          voucherCode: code,
          type: 'voucher_topup',
          amount: voucher.value,
          balanceAfter: energyCredit,
        },
      ],
      opts,
    );
    return {
      energyCredit,
      amount: voucher.value,
      code,
    };
  };
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await claim(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
  return claim();
}
