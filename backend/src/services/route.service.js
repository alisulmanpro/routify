import { Delivery } from '../models/delivery.js';
import { Route } from '../models/route.js';
import { User } from '../models/user.js';
import { getSettings } from './settings.service.js';
import { detectServiceArea, geocodeMany, isInsideArea } from './geocoding.service.js';
import { planRoute } from './route-planner.service.js';
import { cleanDeliveryAddress, serializeDelivery } from './serializers.js';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { haversineKm, normalizeAddress } from '../utils/geo.js';
import { round2, todayKey } from '../utils/http.js';

const OPEN = ['pending', 'in_progress'];
const ROUTE_ROAD_FACTOR = 1.3;

export function summarize(deliveries, route) {
  return {
    total: deliveries.length,
    delivered: deliveries.filter((d) => d.status === 'delivered').length,
    failed: deliveries.filter((d) => d.status === 'failed').length,
    pending: deliveries.filter((d) => OPEN.includes(d.status)).length,
    distanceKm: route?.distanceKm ?? 0,
    routeMinutes: route?.startedAt && route?.completedAt ? Math.max(1, Math.round((new Date(route.completedAt) - new Date(route.startedAt)) / 60000)) : null,
  };
}

export async function serializeRoute(route) {
  const deliveries = await Delivery.find({ _id: { $in: route.stops.map((s) => s.deliveryId) } }).lean();
  const byId = new Map(deliveries.map((d) => [String(d._id), d]));
  const stops = [...route.stops]
    .sort((a, b) => a.order - b.order)
    .filter((s) => byId.has(String(s.deliveryId)))
    .map((s, i) => ({ order: i + 1, legDistanceKm: s.legDistanceKm, legDurationMin: s.legDurationMin, delivery: serializeDelivery(byId.get(String(s.deliveryId))) }));
  const done = stops.filter((s) => !OPEN.includes(s.delivery.status)).length;
  const current = stops.find((s) => OPEN.includes(s.delivery.status));
  return {
    id: String(route._id), status: route.status, preference: route.preference, serviceDate: route.serviceDate,
    origin: route.origin?.latitude != null ? { latitude: route.origin.latitude, longitude: route.origin.longitude } : null,
    distanceKm: route.distanceKm, durationMin: route.durationMin, startedAt: route.startedAt || null, completedAt: route.completedAt || null,
    stops, progress: { total: stops.length, done, remaining: stops.length - done }, currentStopId: current?.delivery.id ?? null,
    summary: summarize(stops.map((s) => byId.get(s.delivery.id)), route),
  };
}

const requireRider = (actor) => { if (actor.role !== 'rider') throw forbidden('Only riders manage routes'); };

async function releasePlanned(actor) {
  const planned = await Route.find({ riderId: actor.id, status: 'planned' }).select('_id').lean();
  if (!planned.length) return;
  const ids = planned.map((r) => r._id);
  await Delivery.updateMany({ routeId: { $in: ids }, status: 'pending' }, { routeId: null, stopOrder: null });
  await Route.deleteMany({ _id: { $in: ids } });
}

/**
 * The rider's service area. Riders who never confirmed a city get one detected from the
 * route's starting point, so their lookups are still scoped.
 */
async function serviceAreaFor(actor, origin) {
  const user = await User.findById(actor.id).select('serviceArea');
  if (user?.serviceArea) return user.serviceArea.toObject();
  if (!origin) return null;
  const area = await detectServiceArea(origin).catch(() => null);
  if (!area) return null;
  user.serviceArea = { ...area, source: 'gps', confirmedAt: new Date() };
  await user.save();
  return user.serviceArea.toObject();
}

async function refreshDeliveryGeocodes(deliveries, { retryApproximate = false, area = null } = {}) {
  for (const delivery of deliveries) {
    const cleanAddress = cleanDeliveryAddress(delivery.address.raw, delivery.payment);
    if (cleanAddress !== delivery.address.raw) {
      delivery.address = { ...delivery.address.toObject(), raw: cleanAddress, normalized: null, latitude: null, longitude: null, geocoded: false, approximate: false, geocodeStatus: 'pending' };
      await delivery.save();
    }
  }

  // On a retry, also redo "found" stops that sit outside the rider's city (e.g. matched abroad before areas existed).
  const outsideArea = (delivery) => retryApproximate && area && delivery.address.geocodeStatus === 'found' && !isInsideArea(delivery.address, area);
  const todo = deliveries.filter((delivery) => outsideArea(delivery) || (delivery.address.geocodeStatus !== 'found' && (retryApproximate || delivery.address.geocodeStatus !== 'approximate')));
  if (!todo.length) return;

  const results = await geocodeMany(todo.map((delivery) => delivery.address.raw), { retryApproximate: retryApproximate || todo.some(outsideArea), area });
  for (const delivery of todo) {
    const hit = results.get(delivery.address.raw);
    delivery.address = hit
      ? { ...delivery.address.toObject(), latitude: hit.latitude, longitude: hit.longitude, normalized: hit.normalized, geocoded: !hit.approximate, approximate: !!hit.approximate, geocodeStatus: hit.approximate ? 'approximate' : 'found' }
      : { ...delivery.address.toObject(), latitude: null, longitude: null, normalized: null, geocoded: false, approximate: false, geocodeStatus: 'not_found' };
    await delivery.save();
  }
}

export async function build(actor, { preference, origin, deliveryIds, date }) {
  requireRider(actor);
  if (await Route.exists({ riderId: actor.id, status: 'active' })) throw conflict('Finish or end your active route before planning a new one', 'ROUTE_ACTIVE');
  await releasePlanned(actor);

  const filter = { riderId: actor.id, status: 'pending', routeId: null };
  if (deliveryIds?.length) filter._id = { $in: deliveryIds };
  const deliveries = await Delivery.find(filter).sort({ createdAt: 1 });
  if (!deliveries.length) throw unprocessable('Add deliveries before building a route', 'NO_DELIVERIES');

  const [settings, user] = await Promise.all([getSettings(), User.findById(actor.id).select('routePreference').lean()]);
  const pref = preference || user?.routePreference || settings.route.defaultPreference;

  // Geocode before ordering so stop numbers reflect destination order, not entry order.
  await refreshDeliveryGeocodes(deliveries, { area: await serviceAreaFor(actor, origin) });

  const located = deliveries.filter((d) => d.address.geocoded);
  const unlocated = deliveries.filter((d) => !d.address.geocoded);
  const plan = planRoute({
    origin, preference: pref, avgSpeedKmh: settings.route.avgSpeedKmh, serviceMinutes: settings.route.stopServiceMinutes,
    stops: located.map((d) => ({ id: String(d._id), latitude: d.address.latitude, longitude: d.address.longitude, addressKey: normalizeAddress(d.address.raw) })),
  });
  const stops = [
    ...plan.order.map((id, i) => ({ deliveryId: id, order: i + 1, legDistanceKm: plan.legs[i].distanceKm, legDurationMin: plan.legs[i].durationMin })),
    ...unlocated.map((d, i) => ({ deliveryId: d._id, order: plan.order.length + i + 1, legDistanceKm: 0, legDurationMin: 0 })),
  ];

  const route = await Route.create({
    riderId: actor.id, serviceDate: date || todayKey(), preference: pref, status: 'planned',
    origin: origin || undefined, stops, distanceKm: plan.distanceKm, durationMin: plan.durationMin + unlocated.length * settings.route.stopServiceMinutes,
  });
  await Delivery.bulkWrite(stops.map((s) => ({ updateOne: { filter: { _id: s.deliveryId }, update: { routeId: route._id, stopOrder: s.order } } })));
  return serializeRoute(route);
}

export async function retryGeocoding(actor, id) {
  requireRider(actor);
  const route = await findMine(actor, id);
  if (!['planned', 'active'].includes(route.status)) throw conflict('Only planned or active routes can retry address lookup', 'INVALID_STATE');
  const deliveries = await Delivery.find({ riderId: actor.id, _id: { $in: route.stops.map((stop) => stop.deliveryId) } });
  const area = await serviceAreaFor(actor, route.origin?.latitude != null ? route.origin : null);
  await refreshDeliveryGeocodes(deliveries, { retryApproximate: true, area });

  const [settings, user] = await Promise.all([
    getSettings(), User.findById(actor.id).select('routePreference').lean(),
  ]);
  const byId = new Map(deliveries.map((delivery) => [String(delivery._id), delivery]));
  const origin = route.origin?.latitude != null ? route.origin : null;

  if (route.status === 'planned') {
    const located = deliveries.filter((delivery) => delivery.address.geocoded);
    const unlocated = deliveries.filter((delivery) => !delivery.address.geocoded);
    const plan = planRoute({
      origin: origin || undefined, preference: route.preference || user?.routePreference || settings.route.defaultPreference,
      avgSpeedKmh: settings.route.avgSpeedKmh, serviceMinutes: settings.route.stopServiceMinutes,
      stops: located.map((delivery) => ({ id: String(delivery._id), latitude: delivery.address.latitude, longitude: delivery.address.longitude, addressKey: normalizeAddress(delivery.address.raw) })),
    });
    const reorderedStops = [
      ...plan.order.map((deliveryId, index) => ({ deliveryId, order: index + 1, legDistanceKm: plan.legs[index].distanceKm, legDurationMin: plan.legs[index].durationMin })),
      ...unlocated.map((delivery, index) => ({ deliveryId: delivery._id, order: plan.order.length + index + 1, legDistanceKm: 0, legDurationMin: 0 })),
    ];
    route.stops = reorderedStops;
    route.distanceKm = plan.distanceKm;
    route.durationMin = plan.durationMin + unlocated.length * settings.route.stopServiceMinutes;
    await route.save();
    await Delivery.bulkWrite(reorderedStops.map((stop) => ({ updateOne: { filter: { _id: stop.deliveryId, riderId: actor.id }, update: { routeId: route._id, stopOrder: stop.order } } })));
  } else {
    let previous = origin;
    let distanceKm = 0;
    let travelMinutes = 0;
    for (const stop of [...route.stops].sort((a, b) => a.order - b.order)) {
      const delivery = byId.get(String(stop.deliveryId));
      if (!delivery?.address.geocoded) {
        previous = null;
        continue;
      }
      const distance = previous ? round2(haversineKm(previous, delivery.address) * ROUTE_ROAD_FACTOR) : 0;
      stop.legDistanceKm = distance;
      stop.legDurationMin = Math.round((distance / settings.route.avgSpeedKmh) * 60);
      distanceKm += distance;
      travelMinutes += stop.legDurationMin;
      previous = delivery.address;
    }
    route.distanceKm = round2(distanceKm);
    route.durationMin = travelMinutes + route.stops.length * settings.route.stopServiceMinutes;
    await route.save();
  }
  return serializeRoute(route);
}

async function findMine(actor, id) {
  const route = await Route.findOne({ _id: id, riderId: actor.id });
  if (!route) throw notFound('Route');
  return route;
}

export async function getById(actor, id) {
  requireRider(actor);
  return serializeRoute(await findMine(actor, id));
}

export async function getCurrent(actor) {
  requireRider(actor);
  const route = (await Route.findOne({ riderId: actor.id, status: 'active' })) || (await Route.findOne({ riderId: actor.id, status: 'planned' }).sort({ createdAt: -1 }));
  return route ? serializeRoute(route) : null;
}

export async function start(actor, id) {
  requireRider(actor);
  const route = await findMine(actor, id);
  if (route.status === 'active') return serializeRoute(route);
  if (route.status !== 'planned') throw conflict('This route is already completed', 'INVALID_STATE');
  const stillPending = await Delivery.countDocuments({ routeId: route._id, status: 'pending' });
  if (!stillPending) throw conflict('This route has no pending deliveries. Build a new one.', 'ROUTE_STALE');
  if (await Route.exists({ riderId: actor.id, status: 'active' })) throw conflict('You already have an active route', 'ROUTE_ACTIVE');
  route.status = 'active';
  route.startedAt = new Date();
  await route.save();
  return serializeRoute(route);
}

/** Completes the route automatically once no stop is left open. */
export async function onStopFinished(routeId) {
  const open = await Delivery.countDocuments({ routeId, status: { $in: OPEN } });
  if (!open) await Route.updateOne({ _id: routeId, status: 'active' }, { status: 'completed', completedAt: new Date() });
}

export async function listCompleted(actor, limit = 30) {
  requireRider(actor);
  const routes = await Route.find({ riderId: actor.id, status: 'completed' }).sort({ completedAt: -1 }).limit(limit);
  return Promise.all(routes.map(serializeRoute));
}
