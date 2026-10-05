import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { Payment } from '../models/payment.js';
import { Delivery } from '../models/delivery.js';
import { Report } from '../models/report.js';
import { getSettings } from './settings.service.js';
import { AppError, conflict, notFound, unprocessable } from '../utils/errors.js';

/** First-run defaults. Prices/limits are placeholders: owners edit them in Admin → Plans. */
export async function ensureDefaultPlans() {
  if (await Plan.estimatedDocumentCount()) return;
  const { defaultCurrency } = await getSettings();
  await Plan.insertMany([
    { key: 'trial', name: 'Free Trial', monthlyPrice: 0, annualPrice: 0, currency: defaultCurrency, limits: { deliveriesPerMonth: 100, reportsPerMonth: 31 }, features: ['PDF import', 'Route planning', 'Daily reports'] },
    { key: 'starter', name: 'Starter', monthlyPrice: 19, annualPrice: 190, currency: defaultCurrency, limits: { deliveriesPerMonth: 1000, reportsPerMonth: 100 }, features: ['PDF import', 'Route planning', 'Daily reports'] },
    { key: 'pro', name: 'Pro', monthlyPrice: 49, annualPrice: 490, currency: defaultCurrency, limits: { deliveriesPerMonth: 10000, reportsPerMonth: 1000 }, features: ['PDF import', 'Route planning', 'Daily reports', 'Priority support'] },
  ]);
}

export const addPeriod = (from, cycle) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'annual' ? 12 : 1));
  return d;
};

export const effectiveStatus = (sub) => {
  if (!sub) return 'expired';
  if (['expired', 'cancelled'].includes(sub.status)) return sub.status;
  return new Date(sub.currentPeriodEnd) < new Date() ? 'expired' : sub.status;
};

export async function createTrial(userId) {
  const settings = await getSettings();
  const plan = await Plan.findOne({ key: 'trial' }).lean();
  const end = new Date(Date.now() + settings.trialDays * 86_400_000);
  return Subscription.create({ userId, planKey: 'trial', billingCycle: 'monthly', status: 'trialing', price: 0, currency: plan?.currency || settings.defaultCurrency, currentPeriodEnd: end });
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

export async function getUsage(actor) {
  const since = monthStart();
  const [deliveries, reports] = await Promise.all([
    Delivery.countDocuments({ riderId: actor.id, createdAt: { $gte: since } }),
    Report.countDocuments({ riderId: actor.id, createdAt: { $gte: since } }),
  ]);
  return { deliveriesThisMonth: deliveries, reportsThisMonth: reports };
}

export const serializePlan = (p) => ({ id: String(p._id), key: p.key, name: p.name, monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice, currency: p.currency, limits: p.limits, features: p.features, active: p.active });

export const serializeSubscription = (s) => s && ({
  id: String(s._id), userId: String(s.userId),
  planKey: s.planKey, billingCycle: s.billingCycle, status: effectiveStatus(s), price: s.price, currency: s.currency,
  startedAt: s.startedAt, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  pending: s.pending?.planKey ? { planKey: s.pending.planKey, billingCycle: s.pending.billingCycle, paymentId: String(s.pending.paymentId) } : null,
});

export async function getMine(actor) {
  const [subscription, plans, usage] = await Promise.all([
    Subscription.findOne({ userId: actor.id }).lean(),
    Plan.find({ active: true }).sort({ monthlyPrice: 1 }).lean(),
    getUsage(actor),
  ]);
  const pendingPlanKey = subscription?.pending?.planKey;
  const pendingPlan = pendingPlanKey ? await Plan.findOne({ key: pendingPlanKey, active: true }).lean() : null;
  const plan = pendingPlan || plans.find((p) => p.key === subscription?.planKey) || (subscription && (await Plan.findOne({ key: subscription.planKey }).lean()));
  return { subscription: serializeSubscription(subscription), plan: plan && serializePlan(plan), plans: plans.map(serializePlan), usage, paymentInstructions: (await getSettings()).platform.paymentInstructions };
}

/** Blocks creating new deliveries when the subscription is not usable or the monthly limit would be exceeded. */
export async function assertCanCreateDeliveries(actor, count = 1) {
  const subscription = await Subscription.findOne({ userId: actor.id }).lean();
  const status = effectiveStatus(subscription);
  if (!['trialing', 'active'].includes(status)) {
    throw new AppError(403, 'SUBSCRIPTION_EXPIRED', status === 'past_due' ? 'Your last payment failed. Update your subscription to add deliveries.' : 'Your subscription has expired. Upgrade to add new deliveries.');
  }
  const plan = await Plan.findOne({ key: subscription.planKey }).lean();
  if (!plan) return;
  const { deliveriesThisMonth } = await getUsage(actor);
  if (deliveriesThisMonth + count > plan.limits.deliveriesPerMonth) {
    throw new AppError(403, 'PLAN_LIMIT_REACHED', `Your ${plan.name} plan allows ${plan.limits.deliveriesPerMonth} deliveries per month (${deliveriesThisMonth} used).`);
  }
}

export async function assertCanCreateReport(actor, isNewReport) {
  if (!isNewReport) return;
  const subscription = await Subscription.findOne({ userId: actor.id }).lean();
  const plan = subscription && (await Plan.findOne({ key: subscription.planKey }).lean());
  if (!plan) return;
  const { reportsThisMonth } = await getUsage(actor);
  if (reportsThisMonth + 1 > plan.limits.reportsPerMonth) throw new AppError(403, 'PLAN_LIMIT_REACHED', `Your ${plan.name} plan allows ${plan.limits.reportsPerMonth} reports per month.`);
}

const priceFor = (plan, cycle) => (cycle === 'annual' ? plan.annualPrice : plan.monthlyPrice);

export async function requestChange(actor, { planKey, billingCycle }) {
  const plan = await Plan.findOne({ key: planKey, active: true }).lean();
  if (!plan || plan.key === 'trial') throw unprocessable('That plan is not available', 'PLAN_UNAVAILABLE');
  const subscription = await Subscription.findOne({ userId: actor.id });
  if (!subscription) throw notFound('Subscription');

  if (subscription.pending?.paymentId) await Payment.updateOne({ _id: subscription.pending.paymentId, status: 'pending' }, { status: 'failed' });

  const payment = await Payment.create({
    userId: actor.id, subscriptionId: subscription._id, planKey, billingCycle,
    amount: priceFor(plan, billingCycle), currency: plan.currency, status: 'pending', provider: 'manual',
  });
  subscription.pending = { planKey, billingCycle, paymentId: payment._id };
  subscription.cancelAtPeriodEnd = false;
  await subscription.save();
  return { payment: { id: String(payment._id), amount: payment.amount, currency: payment.currency, status: payment.status }, subscription: serializeSubscription(subscription) };
}

export async function cancelAtPeriodEnd(actor) {
  const subscription = await Subscription.findOne({ userId: actor.id });
  if (!subscription) throw notFound('Subscription');
  if (subscription.planKey === 'trial') throw conflict('A free trial simply ends on its own', 'CANNOT_CANCEL_TRIAL');
  subscription.cancelAtPeriodEnd = true;
  if (subscription.pending?.paymentId) {
    await Payment.updateOne({ _id: subscription.pending.paymentId, status: 'pending' }, { status: 'failed' });
    subscription.pending = { planKey: null, billingCycle: null, paymentId: null };
  }
  await subscription.save();
  return serializeSubscription(subscription);
}

/** Called when a payment becomes `succeeded`: activates or renews the paid plan. */
export async function applySucceededPayment(payment) {
  const subscription = await Subscription.findOne({ userId: payment.userId });
  if (!subscription) throw notFound('Subscription');
  const renewing = subscription.planKey === payment.planKey && effectiveStatus(subscription) === 'active';
  const start = renewing ? new Date(subscription.currentPeriodEnd) : new Date();
  subscription.planKey = payment.planKey;
  subscription.billingCycle = payment.billingCycle;
  subscription.status = 'active';
  subscription.price = payment.amount;
  subscription.currency = payment.currency;
  subscription.currentPeriodEnd = addPeriod(start, payment.billingCycle);
  subscription.cancelAtPeriodEnd = false;
  subscription.startedAt = renewing ? subscription.startedAt : new Date();
  subscription.pending = { planKey: null, billingCycle: null, paymentId: null };
  await subscription.save();
  return subscription;
}

/** Periodic job: moves lapsed subscriptions to their terminal status. */
export async function sweepSubscriptions() {
  const now = new Date();
  const expired = await Subscription.updateMany({ status: { $in: ['trialing', 'active', 'past_due'] }, currentPeriodEnd: { $lt: now } }, { status: 'expired' });
  return expired.modifiedCount ?? 0;
}

export async function adminUpdateSubscription(id, patch) {
  const subscription = await Subscription.findById(id);
  if (!subscription) throw notFound('Subscription');
  if (patch.planKey) {
    const plan = await Plan.findOne({ key: patch.planKey }).lean();
    if (!plan) throw unprocessable('Unknown plan');
    subscription.planKey = plan.key;
    subscription.currency = plan.currency;
  }
  if (patch.billingCycle) subscription.billingCycle = patch.billingCycle;
  if (patch.planKey || patch.billingCycle) {
    const plan = await Plan.findOne({ key: subscription.planKey }).lean();
    subscription.price = priceFor(plan, subscription.billingCycle);
  }
  if (patch.status) subscription.status = patch.status;
  if (patch.extendDays) subscription.currentPeriodEnd = new Date(Math.max(Date.now(), new Date(subscription.currentPeriodEnd).getTime()) + patch.extendDays * 86_400_000);
  if (patch.status === 'active' && new Date(subscription.currentPeriodEnd) < new Date()) throw unprocessable('Extend the period when re-activating an expired subscription', 'PERIOD_EXPIRED');
  await subscription.save();
  return subscription;
}
