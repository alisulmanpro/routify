import { Delivery } from '../models/delivery.js';
import { Route } from '../models/route.js';
import { assertCanCreateDeliveries } from './subscription.service.js';
import * as storage from './storage.service.js';
import { detectFileType } from '../middleware/upload.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { escapeRegex, paginate, pageMeta, todayKey } from '../utils/http.js';
import { normalizeAddress } from '../utils/geo.js';
import { serializeDelivery } from './serializers.js';
import { onStopFinished } from './route.service.js';

const toDoc = (actor, item, serviceDate) => ({
  riderId: actor.id, trackingId: item.trackingId,
  customer: { name: item.customer?.name || '', phone: item.customer?.phone || '' },
  address: { raw: item.address.raw, normalized: null, latitude: null, longitude: null, geocoded: false, approximate: false, geocodeStatus: 'pending' },
  note: item.note || undefined, serviceDate: item.serviceDate || serviceDate || todayKey(),
});

export async function createMany(actor, items) {
  if (actor.role !== 'rider') throw forbidden('Only riders create deliveries');
  await assertCanCreateDeliveries(actor, items.length);

  const ids = items.map((i) => i.trackingId);
  const inBatch = new Set();
  const details = [];
  const existing = new Set((await Delivery.find({ riderId: actor.id, trackingId: { $in: ids } }).select('trackingId').lean()).map((d) => d.trackingId));
  items.forEach((item, index) => {
    if (existing.has(item.trackingId)) details.push({ index, path: 'trackingId', code: 'DUPLICATE', message: `Parcel ID ${item.trackingId} already exists` });
    else if (inBatch.has(item.trackingId)) details.push({ index, path: 'trackingId', code: 'DUPLICATE', message: `Parcel ID ${item.trackingId} appears more than once` });
    inBatch.add(item.trackingId);
  });
  if (details.length) throw conflict('Some deliveries are duplicates', 'DUPLICATE_TRACKING_ID', details);

  const docs = await Delivery.create(items.map((item) => toDoc(actor, item)), { ordered: true });
  return docs.map(serializeDelivery);
}

export async function findVisible(actor, id) {
  const filter = actor.role === 'rider' ? { _id: id, riderId: actor.id } : { _id: id };
  const delivery = await Delivery.findOne(filter);
  if (!delivery) throw notFound('Delivery');
  return delivery;
}

export async function get(actor, id) {
  return serializeDelivery(await findVisible(actor, id));
}

export async function list(actor, q) {
  const { page, limit, skip } = paginate(q);
  const filter = {};
  if (actor.role === 'rider') filter.riderId = actor.id;
  else if (q.riderId) filter.riderId = q.riderId;
  if (q.status) filter.status = q.status;
  if (q.date) filter.serviceDate = q.date;
  if (q.dateFrom || q.dateTo) filter.serviceDate = { ...(q.dateFrom && { $gte: q.dateFrom }), ...(q.dateTo && { $lte: q.dateTo }) };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ trackingId: rx }, { 'customer.name': rx }, { 'address.raw': rx }];
  }
  const [items, total] = await Promise.all([
    Delivery.find(filter).sort(q.sort === 'route' ? { stopOrder: 1, createdAt: 1 } : { createdAt: -1 }).skip(skip).limit(limit).lean(),
    Delivery.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(page, limit, total) };
}

export async function update(actor, id, patch) {
  if (actor.role !== 'rider') throw forbidden('Only riders edit deliveries');
  const delivery = await findVisible(actor, id);
  if (delivery.status !== 'pending') throw conflict('Only pending deliveries can be edited', 'INVALID_STATE');

  if (patch.trackingId && patch.trackingId !== delivery.trackingId) {
    if (await Delivery.exists({ riderId: delivery.riderId, trackingId: patch.trackingId, _id: { $ne: delivery._id } })) throw conflict(`Parcel ID ${patch.trackingId} already exists`, 'DUPLICATE_TRACKING_ID');
    delivery.trackingId = patch.trackingId;
  }
  if (patch.customer) delivery.customer = { ...delivery.customer.toObject(), ...patch.customer };
  if (patch.note !== undefined) delivery.note = patch.note || undefined;
  if (patch.address?.raw && normalizeAddress(patch.address.raw) !== normalizeAddress(delivery.address.raw)) {
    delivery.address = { raw: patch.address.raw, normalized: null, latitude: null, longitude: null, geocoded: false, approximate: false, geocodeStatus: 'pending' };
  }
  await delivery.save();
  return serializeDelivery(delivery);
}

export async function remove(actor, id) {
  if (actor.role !== 'rider') throw forbidden('Only riders delete deliveries');
  const delivery = await findVisible(actor, id);
  if (!['pending'].includes(delivery.status)) throw conflict('Only pending deliveries can be deleted', 'INVALID_STATE');
  await delivery.deleteOne();
  if (delivery.routeId) await Route.updateOne({ _id: delivery.routeId, status: 'planned' }, { $pull: { stops: { deliveryId: delivery._id } } });
  if (delivery.routeId) await onStopFinished(delivery.routeId);
}

/** Removes the rider's unstarted delivery queue and any route that has not begun. */
export async function clearOpen(actor) {
  if (actor.role !== 'rider') throw forbidden('Only riders delete deliveries');
  const plannedRoutes = await Route.find({ riderId: actor.id, status: 'planned' }).select('_id').lean();
  const result = await Delivery.deleteMany({ riderId: actor.id, status: 'pending' });
  if (plannedRoutes.length) await Route.deleteMany({ _id: { $in: plannedRoutes.map((route) => route._id) } });
  return { deleted: result.deletedCount, plannedRoutesDeleted: plannedRoutes.length };
}

async function activeRouteFor(delivery) {
  const route = delivery.routeId && (await Route.findById(delivery.routeId).select('status').lean());
  if (!route || route.status !== 'active') throw conflict('Start your route before working on this delivery', 'ROUTE_NOT_ACTIVE');
}

export async function arrive(actor, id) {
  if (actor.role !== 'rider') throw forbidden('Only riders can do this');
  const delivery = await findVisible(actor, id);
  if (delivery.status === 'in_progress') return serializeDelivery(delivery);
  if (delivery.status !== 'pending') throw conflict(`Delivery is already ${delivery.status}`, 'INVALID_STATE');
  await activeRouteFor(delivery);
  delivery.status = 'in_progress';
  delivery.arrivedAt = new Date();
  await delivery.save();
  return serializeDelivery(delivery);
}

export async function attachProof(actor, id, file) {
  if (actor.role !== 'rider') throw forbidden('Only riders can do this');
  const delivery = await findVisible(actor, id);
  if (delivery.status !== 'in_progress') throw conflict('Mark the delivery as Arrived before adding a photo', 'INVALID_STATE');
  const ext = detectFileType(file?.buffer, ['jpg', 'png']);
  const key = await storage.save(file.buffer, 'proofs', ext);
  const previous = delivery.proof?.photoKey;
  delivery.proof = { photoKey: key, photoUrl: `/api/v1/files/${key}`, capturedAt: new Date() };
  await delivery.save();
  if (previous) await storage.remove(previous);
  return serializeDelivery(delivery);
}

export async function deliver(actor, id, { note, allowSkip = false }) {
  if (actor.role !== 'rider') throw forbidden('Only riders can do this');
  const delivery = await findVisible(actor, id);
  if (delivery.status !== 'in_progress') throw conflict('Mark the delivery as Arrived first', 'INVALID_STATE');

  if (delivery.routeId && delivery.stopOrder != null && !allowSkip) {
    const earlierStops = await Delivery.find({
      routeId: delivery.routeId, stopOrder: { $lt: delivery.stopOrder }, status: { $in: ['pending', 'in_progress'] },
    }).select('trackingId stopOrder').sort({ stopOrder: 1 }).lean();
    if (earlierStops.length) {
      throw conflict('Earlier deliveries are still open', 'EARLIER_STOPS_REMAIN', earlierStops.map((stop) => ({ trackingId: stop.trackingId, stopOrder: stop.stopOrder })));
    }
  }

  delivery.status = 'delivered';
  delivery.deliveredAt = new Date();
  if (note) delivery.note = note;
  await delivery.save();
  if (delivery.routeId) await onStopFinished(delivery.routeId);
  return serializeDelivery(delivery);
}

export async function fail(actor, id, { reason, note }) {
  if (actor.role !== 'rider') throw forbidden('Only riders can do this');
  const delivery = await findVisible(actor, id);
  if (delivery.status !== 'in_progress') throw conflict('Mark the delivery as Arrived first', 'INVALID_STATE');
  delivery.status = 'failed';
  delivery.failedAt = new Date();
  delivery.failure = { reason, note: note || undefined };
  await delivery.save();
  if (delivery.routeId) await onStopFinished(delivery.routeId);
  return serializeDelivery(delivery);
}
