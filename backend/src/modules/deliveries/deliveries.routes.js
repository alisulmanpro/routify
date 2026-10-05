import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { uploadPdf, uploadPhoto } from '../../middleware/upload.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';
import * as deliveries from '../../services/delivery.service.js';
import { buildDraft } from '../../services/pdf-import.service.js';
import { serializeDelivery } from '../../services/serializers.js';
import { ok } from '../../utils/http.js';
import { dateKey, idParams, money, pagination, paymentTypeParam, phone, trimmed } from '../common/schemas.js';

const router = Router();
router.use(authenticate);

const paymentInput = z.object({ type: paymentTypeParam, orderValue: money.nullish(), codAmount: money.nullish() }).superRefine((p, ctx) => {
  if (p.type === 'cod' && !(p.codAmount > 0)) ctx.addIssue({ code: 'custom', path: ['codAmount'], message: 'COD requires an Amount to Collect greater than 0' });
});
const deliveryInput = z.object({
  trackingId: trimmed(3, 80), customer: z.object({ name: trimmed(1, 160), phone }), address: z.object({ raw: trimmed(5, 400) }),
  payment: paymentInput, note: z.string().trim().max(1000).optional(), serviceDate: dateKey.optional(),
});
const bulkBody = z.object({ items: z.array(deliveryInput).min(1).max(300) });
const patchBody = z.object({
  trackingId: trimmed(3, 80).optional(), customer: z.object({ name: trimmed(1, 160).optional(), phone: phone.optional() }).optional(),
  address: z.object({ raw: trimmed(5, 400) }).optional(),
  payment: z.object({ type: paymentTypeParam.optional(), orderValue: money.nullish(), codAmount: money.nullish() }).optional(), note: z.string().trim().max(1000).nullish(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const listQuery = z.object({
  ...pagination, status: z.enum(['pending', 'in_progress', 'delivered', 'failed']).optional(), paymentType: paymentTypeParam.optional(),
  date: dateKey.optional(), dateFrom: dateKey.optional(), dateTo: dateKey.optional(), search: z.string().trim().max(100).optional(), sort: z.enum(['route', 'recent']).optional(),
});
const deliverBody = z.object({ note: z.string().trim().max(1000).optional(), cashCollected: z.boolean().optional(), collectedAmount: money.optional(), allowSkip: z.boolean().optional() });
const failBody = z.object({
  reason: z.enum(['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'payment_issue', 'other']),
  note: z.string().trim().max(1000).optional(),
}).superRefine((b, ctx) => { if (b.reason === 'other' && !b.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Please describe the reason' }); });

router.post('/import/pdf', authorize('rider'), uploadLimiter, uploadPdf, async (req, res) => res.json(ok(await buildDraft(req.user, req.file))));
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
router.delete('/:id', authorize('rider'), validate({ params: idParams }), async (req, res) => {
  await deliveries.remove(req.user, req.valid.params.id);
  res.json(ok({ deleted: true }));
});

router.post('/:id/arrive', authorize('rider'), validate({ params: idParams }), async (req, res) => res.json(ok(await deliveries.arrive(req.user, req.valid.params.id))));
router.post('/:id/proof', authorize('rider'), uploadLimiter, validate({ params: idParams }), uploadPhoto, async (req, res) => res.json(ok(await deliveries.attachProof(req.user, req.valid.params.id, req.file))));
router.post('/:id/deliver', authorize('rider'), validate({ params: idParams, body: deliverBody }), async (req, res) => res.json(ok(await deliveries.deliver(req.user, req.valid.params.id, req.valid.body))));
router.post('/:id/fail', authorize('rider'), validate({ params: idParams, body: failBody }), async (req, res) => res.json(ok(await deliveries.fail(req.user, req.valid.params.id, req.valid.body))));

export default router;
