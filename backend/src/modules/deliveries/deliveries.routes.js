import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { uploadPdf, uploadPhoto, uploadDocument } from '../../middleware/upload.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';
import * as deliveries from '../../services/delivery.service.js';
import { buildDraft } from '../../services/pdf-import.service.js';
import { buildDraftFromFile } from '../../services/file-import.service.js';
import { serializeDelivery } from '../../services/serializers.js';
import { ok } from '../../utils/http.js';
import { dateKey, idParams, pagination, phone, trimmed } from '../common/schemas.js';

const router = Router();
router.use(authenticate);

// Customer name and phone are optional: a scanned label often only has the address and parcel ID.
const optionalPhone = z.union([phone, z.literal('')]).optional();
const customerInput = z.object({ name: z.string().trim().max(160).optional(), phone: optionalPhone }).default({});
const deliveryInput = z.object({
  trackingId: trimmed(3, 80), customer: customerInput, address: z.object({ raw: trimmed(5, 400) }),
  note: z.string().trim().max(1000).optional(), serviceDate: dateKey.optional(),
});
const bulkBody = z.object({ items: z.array(deliveryInput).min(1).max(300) });
const patchBody = z.object({
  trackingId: trimmed(3, 80).optional(), customer: z.object({ name: z.string().trim().max(160).optional(), phone: optionalPhone }).optional(),
  address: z.object({ raw: trimmed(5, 400) }).optional(), note: z.string().trim().max(1000).nullish(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const listQuery = z.object({
  ...pagination, status: z.enum(['pending', 'in_progress', 'delivered', 'failed']).optional(),
  date: dateKey.optional(), dateFrom: dateKey.optional(), dateTo: dateKey.optional(), search: z.string().trim().max(100).optional(), sort: z.enum(['route', 'recent']).optional(),
});
const deliverBody = z.object({ note: z.string().trim().max(1000).optional(), allowSkip: z.boolean().optional() });
const failBody = z.object({
  reason: z.enum(['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'other']),
  note: z.string().trim().max(1000).optional(),
}).superRefine((b, ctx) => { if (b.reason === 'other' && !b.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Please describe the reason' }); });

router.post('/import/pdf', authorize('rider'), uploadLimiter, uploadPdf, async (req, res) => res.json(ok(await buildDraft(req.user, req.file))));
router.post('/import/file', authorize('rider'), uploadLimiter, uploadDocument, async (req, res) => res.json(ok(await buildDraftFromFile(req.user, req.file))));
router.post('/manual', authorize('rider'), validate({ body: deliveryInput }), async (req, res) => {
  const [created] = await deliveries.createMany(req.user, [req.valid.body]);
  res.status(201).json(ok(created));
});
router.post('/bulk', authorize('rider'), validate({ body: bulkBody }), async (req, res) => res.status(201).json(ok(await deliveries.createMany(req.user, req.valid.body.items))));

router.get('/', authorize('rider'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await deliveries.list(req.user, req.valid.query);
  res.json(ok(items.map(serializeDelivery), meta));
});
router.get('/:id', authorize('rider'), validate({ params: idParams }), async (req, res) => res.json(ok(await deliveries.get(req.user, req.valid.params.id))));
router.patch('/:id', authorize('rider'), validate({ params: idParams, body: patchBody }), async (req, res) => res.json(ok(await deliveries.update(req.user, req.valid.params.id, req.valid.body))));
router.delete('/', authorize('rider'), async (req, res) => res.json(ok(await deliveries.clearOpen(req.user))));
router.delete('/:id', authorize('rider'), validate({ params: idParams }), async (req, res) => {
  await deliveries.remove(req.user, req.valid.params.id);
  res.json(ok({ deleted: true }));
});

router.post('/:id/arrive', authorize('rider'), validate({ params: idParams }), async (req, res) => res.json(ok(await deliveries.arrive(req.user, req.valid.params.id))));
router.post('/:id/proof', authorize('rider'), uploadLimiter, validate({ params: idParams }), uploadPhoto, async (req, res) => res.json(ok(await deliveries.attachProof(req.user, req.valid.params.id, req.file))));
router.post('/:id/deliver', authorize('rider'), validate({ params: idParams, body: deliverBody }), async (req, res) => res.json(ok(await deliveries.deliver(req.user, req.valid.params.id, req.valid.body))));
router.post('/:id/fail', authorize('rider'), validate({ params: idParams, body: failBody }), async (req, res) => res.json(ok(await deliveries.fail(req.user, req.valid.params.id, req.valid.body))));

export default router;
