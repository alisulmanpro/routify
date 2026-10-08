import PDFDocument from 'pdfkit';
import { Delivery } from '../models/delivery.js';
import { Route } from '../models/route.js';
import { Report } from '../models/report.js';
import { User } from '../models/user.js';
import * as storage from './storage.service.js';
import { getSettings } from './settings.service.js';
import { assertCanCreateReport } from './subscription.service.js';
import { summarize } from './route.service.js';
import { forbidden, notFound, unprocessable } from '../utils/errors.js';
import { signFileUrl } from '../utils/signed-url.js';

export const serializeReport = (r, extra = {}) => ({
  id: String(r._id), date: r.date, riderId: String(r.riderId),
  summary: r.summary, generatedAt: r.generatedAt, fileSize: r.fileSize,
  downloadUrl: signFileUrl(r.fileKey, { download: true }), viewUrl: signFileUrl(r.fileKey), ...extra,
});

const label = { customer_unavailable: 'Customer unavailable', customer_refused: 'Customer refused', wrong_address: 'Wrong address', phone_unreachable: 'Phone unreachable', business_closed: 'Business closed', payment_issue: 'Payment issue', other: 'Other' };

async function renderPdf({ rider, date, summary, deliveries, includePhotos }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Delivery report ${date}`, Author: 'Routify' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(20).text('Daily delivery report', { align: 'left' });
  doc.moveDown(0.2).fontSize(11).fillColor('#555').text(`Rider: ${rider.fullName}   |   Date: ${date}`).fillColor('#000').moveDown();
  doc.fontSize(13).text('Route summary').moveDown(0.3).fontSize(10);
  [
    ['Total deliveries', summary.total], ['Delivered', summary.delivered], ['Failed', summary.failed], ['Not completed', summary.pending],
    ['Distance (planned)', `${summary.distanceKm} km`], ['Route time', summary.routeMinutes ? `${summary.routeMinutes} min` : '-'],
  ].forEach(([k, v]) => doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(String(v)).font('Helvetica'));
  doc.moveDown();

  for (const [index, d] of deliveries.entries()) {
    if (doc.y > 610) doc.addPage();
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#ddd').stroke().moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text(`${index + 1}. Parcel ${d.trackingId} - ${d.status.toUpperCase().replace('_', ' ')}`).font('Helvetica').fontSize(10);
    const customer = [d.customer?.name, d.customer?.phone && `(${d.customer.phone})`].filter(Boolean).join('  ');
    if (customer) doc.text(`Customer: ${customer}`);
    doc.text(`Address: ${d.address.raw}`);
    const when = d.deliveredAt || d.failedAt;
    if (when) doc.text(`${d.status === 'delivered' ? 'Delivered' : 'Failed'} at: ${new Date(when).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
    if (d.failure?.reason) doc.text(`Failure reason: ${label[d.failure.reason]}${d.failure.note ? ` - ${d.failure.note}` : ''}`);
    if (d.note) doc.text(`Note: ${d.note}`);
    if (includePhotos && d.proof?.photoKey) {
      try {
        const image = await storage.read(d.proof.photoKey);
        if (doc.y > 560) doc.addPage();
        doc.moveDown(0.3).image(image, { fit: [220, 160] }).moveDown(0.3);
      } catch {
        doc.fillColor('#b00').text('Proof photo could not be loaded.').fillColor('#000');
      }
    }
    doc.moveDown(0.6);
  }
  doc.end();
  return done;
}

export async function generate(actor, date) {
  if (actor.role !== 'rider') throw forbidden('Only riders generate reports');
  const deliveries = await Delivery.find({ riderId: actor.id, serviceDate: date }).sort({ stopOrder: 1, createdAt: 1 }).lean();
  if (!deliveries.length) throw unprocessable('There are no deliveries for this date', 'NO_DELIVERIES');

  const existing = await Report.findOne({ riderId: actor.id, date });
  await assertCanCreateReport(actor, !existing);

  const [rider, route, settings] = await Promise.all([
    User.findById(actor.id).select('fullName').lean(),
    Route.findOne({ riderId: actor.id, serviceDate: date, status: { $in: ['completed', 'active'] } }).sort({ createdAt: -1 }).lean(),
    getSettings(),
  ]);
  const summary = summarize(deliveries, route);
  const buffer = await renderPdf({ rider, date, summary, deliveries, includePhotos: settings.reports.includePhotos });
  const fileKey = await storage.save(buffer, 'reports', 'pdf');

  const previous = existing?.fileKey;
  const report = await Report.findOneAndUpdate(
    { riderId: actor.id, date },
    { riderId: actor.id, date, summary, fileKey, fileSize: buffer.length, generatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (previous) await storage.remove(previous);
  return serializeReport(report);
}

export async function findVisible(actor, id) {
  const report = await Report.findOne(actor.role === 'rider' ? { _id: id, riderId: actor.id } : { _id: id });
  if (!report) throw notFound('Report');
  return report;
}

export async function listMine(actor, { limit = 60 } = {}) {
  const reports = await Report.find({ riderId: actor.id }).sort({ date: -1 }).limit(limit).lean();
  return reports.map((r) => serializeReport(r));
}
