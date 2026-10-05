import mongoose from 'mongoose';
import { Delivery } from '../models/delivery.js';
import { Route } from '../models/route.js';
import { Report } from '../models/report.js';
import { User } from '../models/user.js';
import { summarize } from './route.service.js';
import { round2 } from '../utils/http.js';

const OPEN = ['pending', 'in_progress'];

export async function dashboard(actor, date) {
  const [user, deliveries, route] = await Promise.all([
    User.findById(actor.id).select('fullName currency').lean(),
    Delivery.find({ riderId: actor.id, $or: [{ serviceDate: date }, { status: { $in: OPEN } }] }).lean(),
    Route.findOne({ riderId: actor.id, status: { $in: ['active', 'planned'] } }).sort({ status: 1, createdAt: -1 }).lean(),
  ]);
  const s = summarize(deliveries, route?.status === 'active' ? route : null);
  const finished = s.delivered + s.failed;

  let nextAction = 'setup';
  if (route?.status === 'active') nextAction = 'continue';
  else if (s.pending > 0) nextAction = 'start';
  else if (s.total > 0) nextAction = 'complete';

  return {
    rider: { id: actor.id, fullName: user.fullName, currency: user.currency },
    date, ...s,
    progressPercent: s.total ? Math.round((finished / s.total) * 100) : 0,
    routeId: route ? String(route._id) : null,
    routeStatus: route?.status || null,
    nextAction,
    map: deliveries.filter((d) => d.address?.geocoded).map((d) => ({ id: String(d._id), latitude: d.address.latitude, longitude: d.address.longitude, status: d.status, order: d.stopOrder })),
  };
}

/** One row per service date with totals + report/route info. */
export async function history(actor, limit = 60) {
  const [rows, reports, routes] = await Promise.all([
    Delivery.aggregate([
      { $match: { riderId: new mongoose.Types.ObjectId(actor.id) } },
      { $group: { _id: { d: '$serviceDate', s: '$status', t: '$payment.type' }, count: { $sum: 1 }, collected: { $sum: '$payment.codCollectedAmount' } } },
    ]),
    Report.find({ riderId: actor.id }).select('date').lean(),
    Route.find({ riderId: actor.id, status: 'completed' }).select('serviceDate distanceKm startedAt completedAt').lean(),
  ]);

  const days = new Map();
  for (const { _id, count, collected } of rows) {
    const day = days.get(_id.d) || { date: _id.d, total: 0, delivered: 0, failed: 0, pending: 0, prepaid: 0, cod: 0, codCollected: 0, distanceKm: 0 };
    day.total += count;
    if (_id.s === 'delivered') day.delivered += count;
    else if (_id.s === 'failed') day.failed += count;
    else day.pending += count;
    if (_id.t === 'cod') { day.cod += count; day.codCollected = round2(day.codCollected + (collected || 0)); } else day.prepaid += count;
    days.set(_id.d, day);
  }
  for (const r of routes) if (days.has(r.serviceDate)) days.get(r.serviceDate).distanceKm = round2(days.get(r.serviceDate).distanceKm + (r.distanceKm || 0));
  for (const r of reports) if (days.has(r.date)) days.get(r.date).hasReport = true;

  const currency = (await User.findById(actor.id).select('currency').lean()).currency;
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit).map((d) => ({ ...d, hasReport: !!d.hasReport, currency }));
}
