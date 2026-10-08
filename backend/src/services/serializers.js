import { signFileUrl } from '../utils/signed-url.js';

/** Older imports appended "COD 1500" to addresses; strip it when it matches the stored amount. */
export function cleanDeliveryAddress(raw, payment) {
  const address = String(raw || '');
  if (payment?.type !== 'cod' || !(payment.codAmount > 0)) return address;
  const suffix = /\s+(?:COD|cash\s+on\s+delivery)(?:\s+[A-Z]{3})?\s+([\d,]+(?:\.\d{1,2})?)\s*$/i.exec(address);
  if (!suffix || Number(suffix[1].replace(/,/g, '')) !== Number(payment.codAmount)) return address;
  return address.slice(0, suffix.index).trim().replace(/[,;\s]+$/, '');
}

export function serializeDelivery(d) {
  const flags = [];
  if (d.address?.geocodeStatus === 'not_found') flags.push('location_not_found');
  if (d.address?.geocodeStatus === 'approximate' || d.address?.approximate) flags.push('approximate_location');
  return {
    id: String(d._id), riderId: String(d.riderId),
    trackingId: d.trackingId,
    customer: { name: d.customer?.name || '', phone: d.customer?.phone || '' },
    address: { raw: cleanDeliveryAddress(d.address?.raw, d.payment), normalized: d.address?.normalized ?? null, latitude: d.address?.latitude ?? null, longitude: d.address?.longitude ?? null, geocoded: !!d.address?.geocoded, approximate: !!d.address?.approximate, geocodeStatus: d.address?.geocodeStatus || 'pending' },
    status: d.status,
    proof: d.proof?.photoKey ? { photoUrl: signFileUrl(d.proof.photoKey), capturedAt: d.proof.capturedAt } : null,
    note: d.note || null,
    failure: d.failure?.reason ? { reason: d.failure.reason, note: d.failure.note || null } : null,
    serviceDate: d.serviceDate, routeId: d.routeId ? String(d.routeId) : null, stopOrder: d.stopOrder ?? null,
    arrivedAt: d.arrivedAt || null, deliveredAt: d.deliveredAt || null, failedAt: d.failedAt || null,
    createdAt: d.createdAt, flags,
  };
}
