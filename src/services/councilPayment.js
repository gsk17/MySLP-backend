import { config } from '../config.js';
import { Payment } from '../models/Payment.js';
import { notifyCouncilPayment } from './notifications.js';

/**
 * The Shangri-La Council's cost-of-living payment.
 *
 * The brief: "the Shangri-La Council has announced a payment of 200 Shangri-La
 * dollars (SLD) for residents whose homes are in Council Tax bands A to D."
 * It is credited to the customer's energy credit, which is the only place the
 * app holds money for them.
 *
 * Two rules the implementation has to respect:
 *
 *   Paid once, ever. `councilPaymentPaidAt` records it on the user, rather
 *   than the band being read as "has been paid". A customer who moves from
 *   band C to band F keeps what they were given, and moving back later does
 *   not pay them again.
 *
 *   Never clawed back. If an address change moves someone out of bands A–D,
 *   the money already paid stays paid — it was correct when it was made.
 */

export function isEligibleBand(band) {
  return config.councilPayment.eligibleBands.includes(String(band ?? '').toUpperCase());
}

/**
 * Credits the payment if this customer qualifies and has not had it.
 *
 * Takes a User document, mutates and saves it, and returns the Payment when
 * one was made, or null when nothing was owed. Safe to call on every
 * registration and every address change.
 */
export async function awardCouncilPaymentIfDue(user) {
  if (!user || user.role !== 'customer') return null;
  if (user.councilPaymentPaidAt) return null;
  if (!isEligibleBand(user.councilTaxBand)) return null;

  const amount = config.councilPayment.amount;
  user.energyCredit = round2(user.energyCredit + amount);
  user.councilPaymentPaidAt = new Date();
  await user.save();

  const payment = await Payment.create({
    userId: user._id,
    type: 'council_payment',
    amount,
    balanceAfter: user.energyCredit,
  });

  // Best effort: telling someone about the money must not fail paying it.
  void notifyCouncilPayment(user, amount);

  return payment;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
