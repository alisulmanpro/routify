import { User } from '../models/user.js';
import { Delivery } from '../models/delivery.js';
import { Route } from '../models/route.js';
import { Report } from '../models/report.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { Payment } from '../models/payment.js';
import { AuditLog } from '../models/audit-log.js';
import { RefreshToken } from '../models/refresh-token.js';
import { serializeDelivery } from './serializers.js';
import { serializeReport } from './report.service.js';
import { effectiveStatus, serializePlan, serializeSubscription } from './subscription.service.js';
import { serializeUser } from './auth.service.js';
import { notFound, conflict } from '../utils/errors.js';
import { escapeRegex, pageMeta, paginate, round2, todayKey } from '../utils/http.js';

const DAY = 86_400_000;
const dayKey = (offset = 0) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const pct = (now, before) => (before === 0 ? (now === 0 ? 0 : 100) : Math.round(((now - before) / before) * 100));
const nameMap = (docs, field) => new Map(docs.map((d) => [String(d._id), d[field]]));
const rx = (s) => new RegExp(escapeRegex(s), 'i');

async function userNames(ids) { return nameMap(await User.find({ _id: { $in: ids } }).select('fullName').lean(), 'fullName'); }

export async function overview({ days = 7 } = {}) {
  const today = todayKey();
  const since = dayKey(-(days - 1));
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const day30 = new Date(Date.now() - 29 * DAY);

  const [riderCount, newRiders7, newRidersPrev7, activeRiders24h, activeRoutes, deliveriesToday, del7, delPrev7,
    subGroups, volumeRows, subsRecent, paymentsRecent, revenueMonth, recent, liveRoutes] = await Promise.all([
    User.countDocuments({ role: 'rider' }),
    User.countDocuments({ role: 'rider', createdAt: { $gte: new Date(Date.now() - 7 * DAY) } }),
    User.countDocuments({ role: 'rider', createdAt: { $gte: new Date(Date.now() - 14 * DAY), $lt: new Date(Date.now() - 7 * DAY) } }),
    User.countDocuments({ role: 'rider', lastActiveAt: { $gte: new Date(Date.now() - DAY) } }),
    Route.countDocuments({ status: 'active' }),
    Delivery.countDocuments({ serviceDate: today }),
    Delivery.countDocuments({ serviceDate: { $gte: dayKey(-6), $lte: today } }),
    Delivery.countDocuments({ serviceDate: { $gte: dayKey(-13), $lt: dayKey(-6) } }),
    Subscription.aggregate([{ $group: { _id: { plan: '$planKey', status: '$status', cycle: '$billingCycle' }, count: { $sum: 1 } } }]),
    Delivery.aggregate([{ $match: { serviceDate: { $gte: since, $lte: today } } }, { $group: { _id: { d: '$serviceDate', s: '$status' }, count: { $sum: 1 } } }]),
    Subscription.find({ createdAt: { $gte: day30 } }).select('createdAt').lean(),
    Payment.find({ status: 'succeeded', paidAt: { $gte: day30 } }).select('paidAt amount currency').lean(),
    Payment.aggregate([{ $match: { status: 'succeeded', paidAt: { $gte: monthStart } } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }]),
    Delivery.find().sort({ createdAt: -1 }).limit(8).lean(),
    Route.find({ status: 'active' }).sort({ startedAt: -1 }).limit(6).lean(),
  ]);

  const subs = { total: 0, active: 0, trialing: 0, expired: 0, pastDue: 0, cancelled: 0, byPlan: { trial: 0, starter: 0, pro: 0 }, byCycle: { monthly: 0, annual: 0 } };
  for (const { _id, count } of subGroups) {
    subs.total += count;
    subs.byPlan[_id.plan] += count;
    if (_id.status === 'active') { subs.active += count; subs.byCycle[_id.cycle] += count; }
    if (_id.status === 'trialing') subs.trialing += count;
    if (_id.status === 'expired') subs.expired += count;
    if (_id.status === 'past_due') subs.pastDue += count;
    if (_id.status === 'cancelled') subs.cancelled += count;
  }

  const volume = Array.from({ length: days }, (_, i) => ({ date: dayKey(-(days - 1 - i)), total: 0, delivered: 0, failed: 0 }));
  for (const { _id, count } of volumeRows) {
    const row = volume.find((v) => v.date === _id.d);
    if (!row) continue;
    row.total += count;
    if (_id.s === 'delivered') row.delivered += count;
    if (_id.s === 'failed') row.failed += count;
  }

  const trendDays = Array.from({ length: 30 }, (_, i) => dayKey(-(29 - i)));
  const newSubsByDay = new Map();
  subsRecent.forEach((s) => { const k = s.createdAt.toISOString().slice(0, 10); newSubsByDay.set(k, (newSubsByDay.get(k) || 0) + 1); });
  const revenueByDay = new Map();
  paymentsRecent.forEach((p) => { const k = p.paidAt.toISOString().slice(0, 10); const m = revenueByDay.get(k) || {}; m[p.currency] = round2((m[p.currency] || 0) + p.amount); revenueByDay.set(k, m); });

  const [riders, routeProgress] = await Promise.all([
    userNames([...recent.map((d) => d.riderId), ...liveRoutes.map((r) => r.riderId)]),
    liveRoutes.length ? Delivery.aggregate([{ $match: { routeId: { $in: liveRoutes.map((r) => r._id) } } }, { $group: { _id: { r: '$routeId', s: '$status' }, count: { $sum: 1 } } }]) : [],
  ]);

  return {
    metrics: {
      riders: riderCount, ridersChangePct: pct(newRiders7, newRidersPrev7),
      activeRiders24h, activeRoutes,
      deliveriesToday, deliveriesWeek: del7, deliveriesChangePct: pct(del7, delPrev7),
      subscriptionRevenueMonth: revenueMonth.map((c) => ({ currency: c._id, amount: round2(c.amount) })),
    },
    subscriptions: subs,
    volume,
    subscriptionGrowth: trendDays.map((date) => ({ date, newSubscriptions: newSubsByDay.get(date) || 0 })),
    revenueTrend: trendDays.map((date) => ({ date, byCurrency: revenueByDay.get(date) || {} })),
    liveRoutes: liveRoutes.map((r) => {
      const mine = routeProgress.filter((p) => String(p._id.r) === String(r._id));
      const open = mine.filter((p) => ['pending', 'in_progress'].includes(p._id.s)).reduce((n, p) => n + p.count, 0);
      const closed = mine.filter((p) => !['pending', 'in_progress'].includes(p._id.s)).reduce((n, p) => n + p.count, 0);
      return { id: String(r._id), rider: riders.get(String(r.riderId)) || 'Unknown', done: closed, total: open + closed, startedAt: r.startedAt };
    }),
    recentDeliveries: recent.map((d) => ({ ...serializeDelivery(d), riderName: riders.get(String(d.riderId)) || null })),
  };
}

/* ---------- Riders ---------- */
export async function listRiders(q) {
  const { page, limit, skip } = paginate(q);
  const filter = { role: 'rider' };
  if (q.status) filter.status = q.status;
  if (q.search) filter.$or = [{ fullName: rx(q.search) }, { email: rx(q.search) }, { phone: rx(q.search) }];
  const [users, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), User.countDocuments(filter)]);
  const ids = users.map((u) => u._id);
  const [subs, groups] = await Promise.all([
    Subscription.find({ userId: { $in: ids } }).lean(),
    Delivery.aggregate([{ $match: { riderId: { $in: ids } } }, { $group: { _id: '$riderId', count: { $sum: 1 } } }]),
  ]);
  const subByUser = new Map(subs.map((s) => [String(s.userId), s]));
  const items = users.map((u) => {
    const sub = subByUser.get(String(u._id));
    return {
      id: String(u._id), fullName: u.fullName, email: u.email, phone: u.phone, status: u.status,
      subscriptionStatus: sub ? effectiveStatus(sub) : null,
      deliveries: groups.find((g) => String(g._id) === String(u._id))?.count || 0,
      lastActiveAt: u.lastActiveAt, registeredAt: u.createdAt,
    };
  });
  return { items, meta: pageMeta(page, limit, total) };
}

export async function updateRider(id, patch) {
  const user = await User.findOneAndUpdate({ _id: id, role: 'rider' }, patch, { new: true });
  if (!user) throw notFound('Rider');
  if (patch.status === 'suspended') await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() });
  return serializeUser(user);
}

/* ---------- Deliveries ---------- */
export async function decorateDeliveries(docs) {
  const riders = await userNames(docs.map((d) => d.riderId));
  return docs.map((d) => ({ ...serializeDelivery(d), riderName: riders.get(String(d.riderId)) || null }));
}

/* ---------- Reports ---------- */
export async function listReports(q) {
  const { page, limit, skip } = paginate(q);
  const filter = {};
  if (q.riderId) filter.riderId = q.riderId;
  if (q.dateFrom || q.dateTo) filter.date = { ...(q.dateFrom && { $gte: q.dateFrom }), ...(q.dateTo && { $lte: q.dateTo }) };
  if (q.search) {
    const users = await User.find({ $or: [{ fullName: rx(q.search) }, { email: rx(q.search) }] }).select('_id').lean();
    filter.riderId = { $in: users.map((u) => u._id) };
  }
  const [reports, total] = await Promise.all([Report.find(filter).sort({ date: -1, generatedAt: -1 }).skip(skip).limit(limit).lean(), Report.countDocuments(filter)]);
  const riders = await userNames(reports.map((r) => r.riderId));
  return { items: reports.map((r) => serializeReport(r, { riderName: riders.get(String(r.riderId)) || null })), meta: pageMeta(page, limit, total) };
}

/* ---------- Subscriptions, plans, payments ---------- */
export async function listSubscriptions(q) {
  const { page, limit, skip } = paginate(q);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.planKey) filter.planKey = q.planKey;
  if (q.billingCycle) filter.billingCycle = q.billingCycle;
  if (q.search) {
    const userIds = await User.find({ role: 'rider', $or: [{ fullName: rx(q.search) }, { email: rx(q.search) }] }).select('_id').lean();
    filter.userId = { $in: userIds.map((u) => u._id) };
  }
  const [subs, total] = await Promise.all([Subscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Subscription.countDocuments(filter)]);
  const riders = await userNames(subs.map((s) => s.userId));
  return {
    items: subs.map((s) => ({ ...serializeSubscription(s), riderName: riders.get(String(s.userId)) || null })),
    meta: pageMeta(page, limit, total),
  };
}

export async function listPlans() {
  const [plans, counts] = await Promise.all([Plan.find().sort({ monthlyPrice: 1 }).lean(), Subscription.aggregate([{ $group: { _id: '$planKey', count: { $sum: 1 } } }])]);
  return plans.map((p) => ({ ...serializePlan(p), subscribers: counts.find((c) => c._id === p.key)?.count || 0 }));
}

export async function updatePlan(key, patch) {
  const plan = await Plan.findOne({ key });
  if (!plan) throw notFound('Plan');
  if (key === 'trial' && patch.active === false) throw conflict('The free trial plan cannot be disabled', 'INVALID_STATE');
  const { limits, ...rest } = patch;
  Object.assign(plan, rest);
  if (limits) Object.assign(plan.limits, limits);
  await plan.save();
  return serializePlan(plan);
}

export async function listPayments(q) {
  const { page, limit, skip } = paginate(q);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.riderId) filter.userId = q.riderId;
  if (q.search) {
    const userIds = await User.find({ role: 'rider', $or: [{ fullName: rx(q.search) }, { email: rx(q.search) }] }).select('_id').lean();
    filter.userId = { $in: userIds.map((u) => u._id) };
  }
  const [payments, total, totals] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([{ $group: { _id: { s: '$status', c: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);
  const riders = await userNames(payments.map((p) => p.userId));
  return {
    items: payments.map((p) => serializePayment(p, { riderName: riders.get(String(p.userId)) || null })),
    totals: totals.map((t) => ({ status: t._id.s, currency: t._id.c, count: t.count, amount: round2(t.amount) })),
    meta: pageMeta(page, limit, total),
  };
}

export const serializePayment = (p, { riderName = null } = {}) => ({
  id: String(p._id), userId: String(p.userId), riderName, planKey: p.planKey, billingCycle: p.billingCycle,
  amount: p.amount, currency: p.currency, status: p.status, provider: p.provider, providerRef: p.providerRef, paidAt: p.paidAt || null, createdAt: p.createdAt,
});

/* ---------- Audit ---------- */
export async function listAuditLogs(q) {
  const { page, limit, skip } = paginate(q);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.action) filter.action = rx(q.action);
  if (q.search) filter.$or = [{ actorEmail: rx(q.search) }, { targetId: rx(q.search) }, { action: rx(q.search) }];
  if (q.dateFrom || q.dateTo) filter.createdAt = { ...(q.dateFrom && { $gte: new Date(`${q.dateFrom}T00:00:00Z`) }), ...(q.dateTo && { $lte: new Date(`${q.dateTo}T23:59:59.999Z`) }) };
  const [logs, total] = await Promise.all([AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), AuditLog.countDocuments(filter)]);
  return {
    items: logs.map((l) => ({ id: String(l._id), createdAt: l.createdAt, actorEmail: l.actorEmail, action: l.action, targetType: l.targetType, targetId: l.targetId, status: l.status, ip: l.ip || null, meta: l.meta })),
    meta: pageMeta(page, limit, total),
  };
}
