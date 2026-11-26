import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { sendNoticeEmail } from './mailer.js';


const money = (n) =>
  `£${Number(n ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });


async function notify(user, type, parts) {
  const prefs = user.notificationPrefs ?? {};
  // `newBill` -> prefs.newBill. Default to on when the field is missing, so an
  // account created before this feature still gets its email.
  const prefKey = {
    new_bill: 'newBill',
    payment_receipt: 'paymentReceipt',
    low_credit: 'lowCredit',
  }[type];
  const wantsEmail = prefs[prefKey] !== false;

  let emailed = false;
  if (wantsEmail) {
    emailed = await sendNoticeEmail(user.email, parts.subject, {
      name: user.fullName,
      heading: parts.heading,
      intro: parts.intro,
      rows: parts.rows ?? [],
      footnote: parts.footnote ?? '',
    });
  }

  await Notification.create({
    userId: user._id,
    type,
    title: parts.title,
    body: parts.body,
    link: parts.link ?? null,
    emailed,
  });
}

//A new bill has been generated from a meter reading.
export async function notifyNewBill(userId, bill) {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    const total = money(bill.totalAmount);
    await notify(user, 'new_bill', {
      title: `New bill: ${total}`,
      body: `For ${shortDate(bill.periodStart)} to ${shortDate(bill.periodEnd)}.`,
      link: '/bills',
      subject: `Your new MySLP bill — ${total}`,
      heading: 'Your new bill is ready',
      intro: `We have worked out your bill from the meter reading you just submitted.`,
      rows: [
        { label: 'Period', value: `${shortDate(bill.periodStart)} — ${shortDate(bill.periodEnd)}` },
        { label: 'Electricity', value: money(bill.dayCost + bill.nightCost) },
        { label: 'Gas', value: money(bill.gasCost) },
        { label: 'Total to pay', value: total },
      ],
      footnote: 'You can pay it from your energy credit in the MySLP app.',
    });
  } catch (err) {
    console.error('[myslp] notifyNewBill failed:', err.message);
  }
}

// A bill has been paid from energy credit. 
export async function notifyPaymentReceipt(userId, { bill, amount, remainingCredit }) {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    await notify(user, 'payment_receipt', {
      title: `Payment of ${money(amount)} received`,
      body: `Your bill for ${shortDate(bill.periodEnd)} is now paid.`,
      link: '/bills',
      subject: `Receipt — ${money(amount)} paid to Shangri-La Power`,
      heading: 'Thank you, your bill is paid',
      intro: 'This is your receipt. No further action is needed.',
      rows: [
        { label: 'Paid', value: money(amount) },
        {
          label: 'Bill period',
          value: `${shortDate(bill.periodStart)} — ${shortDate(bill.periodEnd)}`,
        },
        { label: 'Paid on', value: shortDate(new Date()) },
        { label: 'Energy credit left', value: money(remainingCredit) },
      ],
    });
  } catch (err) {
    console.error('[myslp] notifyPaymentReceipt failed:', err.message);
  }
}

export async function notifyLowCreditIfCrossed(userId, before, after) {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    const prefs = user.notificationPrefs ?? {};
    const threshold = typeof prefs.lowCreditThreshold === 'number' ? prefs.lowCreditThreshold : 50;
    if (!(before > threshold && after <= threshold)) return;

    await notify(user, 'low_credit', {
      title: `Energy credit is low: ${money(after)}`,
      body: `It has fallen below your ${money(threshold)} alert level.`,
      link: '/topup',
      subject: `Your MySLP energy credit is low — ${money(after)}`,
      heading: 'Your energy credit is running low',
      intro: `Your balance has dropped below the ${money(threshold)} you asked to be warned at.`,
      rows: [
        { label: 'Energy credit', value: money(after) },
        { label: 'Your alert level', value: money(threshold) },
      ],
      footnote: 'You can top up with a voucher in the MySLP app.',
    });
  } catch (err) {
    console.error('[myslp] notifyLowCredit failed:', err.message);
  }
}

// The Council's cost-of-living payment has been credited. 
export async function notifyCouncilPayment(user, amount) {
  try {
    await notify(user, 'council_payment', {
      title: `Council payment of ${money(amount)} received`,
      body: `Added to your energy credit because your home is in Council Tax band ${user.councilTaxBand}.`,
      link: '/topup',
      subject: `The Shangri-La Council has paid you ${money(amount)}`,
      heading: 'Your Council cost-of-living payment',
      intro:
        'The Shangri-La Council pays this to residents in Council Tax bands A to D. It has been added to your MySLP energy credit.',
      rows: [
        { label: 'Payment', value: money(amount) },
        { label: 'Council Tax band', value: String(user.councilTaxBand ?? '-') },
        { label: 'Energy credit now', value: money(user.energyCredit) },
      ],
      footnote: 'There is nothing to claim — the money is already on your account.',
    });
  } catch (err) {
    console.error('[myslp] notifyCouncilPayment failed:', err.message);
  }
}
