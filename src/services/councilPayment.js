import { config } from '../config.js';
import { Payment } from '../models/Payment.js';
import { notifyCouncilPayment } from './notifications.js';


export function isEligibleBand(band) {
  return config.councilPayment.eligibleBands.includes(String(band ?? '').toUpperCase());
}

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
