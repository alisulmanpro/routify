import { Payment } from '../models/payment.js';
import { Plan } from '../models/plan.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import { applySucceededPayment } from './subscription.service.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';

const TRANSITIONS = { pending: ['succeeded', 'failed'], succeeded: ['refunded'], failed: [], refunded: [] };

/** SaaS subscription payments only, always billed directly to the rider; customer COD money never touches this collection. */
export async function recordManual({ userId, planKey, billingCycle, amount, currency, status = 'succeeded', providerRef }) {
  const [rider, plan, subscription] = await Promise.all([
    User.findOne({ _id: userId, role: 'rider' }).lean(),
    Plan.findOne({ key: planKey }).lean(),
    Subscription.findOne({ userId }),
  ]);
  if (!rider) throw notFound('Rider');
  if (!plan || plan.key === 'trial') throw unprocessable('Choose a paid plan');
  const payment = await Payment.create({
    userId, subscriptionId: subscription?._id, planKey, billingCycle,
    amount: amount ?? (billingCycle === 'annual' ? plan.annualPrice : plan.monthlyPrice), currency: currency || plan.currency,
    status: 'pending', provider: 'manual', providerRef: providerRef || null,
  });
  return status === 'pending' ? payment : setStatus(payment._id, status);
}

export async function setStatus(id, next) {
  const payment = await Payment.findById(id);
  if (!payment) throw notFound('Payment');
  if (payment.status === next) return payment;
  if (!TRANSITIONS[payment.status].includes(next)) throw conflict(`A ${payment.status} payment cannot become ${next}`, 'INVALID_STATE');

  payment.status = next;
  if (next === 'succeeded') payment.paidAt = new Date();
  await payment.save();

  if (next === 'succeeded') await applySucceededPayment(payment);
  if (next === 'failed') {
    await Subscription.updateOne({ userId: payment.userId, 'pending.paymentId': payment._id }, { pending: { planKey: null, billingCycle: null, paymentId: null } });
  }
  return payment;
}
