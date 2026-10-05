import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as admin from '../../services/admin.service.js';
import * as deliveries from '../../services/delivery.service.js';
import * as payments from '../../services/payment.service.js';
import { adminUpdateSubscription, serializeSubscription } from '../../services/subscription.service.js';
import { getSettings, updateSettings } from '../../services/settings.service.js';
import { audit } from '../../services/audit.service.js';
import { ok } from '../../utils/http.js';
import { currency, dateKey, idParams, money, objectId, pagination, paymentTypeParam, preference, trimmed } from '../common/schemas.js';

const router = Router();
router.use(authenticate, authorize('owner_admin'));

const log = (req, action, targetType, targetId, meta) => audit(req.user, action, { targetType, targetId, meta, ip: req.ip });
const search = z.string().trim().max(100).optional();
const range = { dateFrom: dateKey.optional(), dateTo: dateKey.optional() };

router.get('/overview', validate({ query: z.object({ days: z.coerce.number().refine((n) => [7, 30].includes(n)).optional() }) }), async (req, res) => res.json(ok(await admin.overview({ days: req.valid.query.days }))));

/* Riders — every rider is an independent account: signs up, subscribes, and runs their own deliveries. */
router.get('/riders', validate({ query: z.object({ ...pagination, search, status: z.enum(['active', 'suspended']).optional() }) }), async (req, res) => {
  const { items, meta } = await admin.listRiders(req.valid.query);
  res.json(ok(items, meta));
});
router.patch('/riders/:id', validate({ params: idParams, body: z.object({ status: z.enum(['active', 'suspended']) }) }), async (req, res) => {
  const updated = await admin.updateRider(req.valid.params.id, req.valid.body);
  await log(req, 'rider.update', 'user', updated.id, req.valid.body);
  res.json(ok(updated));
});

/* Deliveries */
router.get('/deliveries', validate({ query: z.object({ ...pagination, ...range, search, date: dateKey.optional(), status: z.enum(['pending', 'in_progress', 'delivered', 'failed']).optional(), paymentType: paymentTypeParam.optional(), riderId: objectId.optional() }) }), async (req, res) => {
  const { items, meta } = await deliveries.list(req.user, req.valid.query);
  res.json(ok(await admin.decorateDeliveries(items), meta));
});
router.get('/deliveries/:id', validate({ params: idParams }), async (req, res) => {
  const delivery = await deliveries.findVisible(req.user, req.valid.params.id);
  res.json(ok((await admin.decorateDeliveries([delivery]))[0]));
});

/* Reports */
router.get('/reports', validate({ query: z.object({ ...pagination, ...range, search, riderId: objectId.optional() }) }), async (req, res) => {
  const { items, meta } = await admin.listReports(req.valid.query);
  res.json(ok(items, meta));
});

/* Subscriptions, plans, payments — always billed directly to the rider */
router.get('/subscriptions', validate({ query: z.object({ ...pagination, search, status: z.enum(['trialing', 'active', 'past_due', 'expired', 'cancelled']).optional(), planKey: z.enum(['trial', 'starter', 'pro']).optional(), billingCycle: z.enum(['monthly', 'annual']).optional() }) }), async (req, res) => {
  const { items, meta } = await admin.listSubscriptions(req.valid.query);
  res.json(ok(items, meta));
});
router.patch('/subscriptions/:id', validate({ params: idParams, body: z.object({ status: z.enum(['trialing', 'active', 'past_due', 'expired', 'cancelled']).optional(), planKey: z.enum(['trial', 'starter', 'pro']).optional(), billingCycle: z.enum(['monthly', 'annual']).optional(), extendDays: z.number().int().min(1).max(3660).optional() }).refine((b) => Object.keys(b).length, 'Nothing to update') }), async (req, res) => {
  const updated = serializeSubscription(await adminUpdateSubscription(req.valid.params.id, req.valid.body));
  await log(req, 'subscription.update', 'subscription', updated.id, req.valid.body);
  res.json(ok(updated));
});

router.get('/plans', async (_req, res) => res.json(ok(await admin.listPlans())));
router.patch('/plans/:key', validate({
  params: z.object({ key: z.enum(['trial', 'starter', 'pro']) }),
  body: z.object({
    name: trimmed(2, 60).optional(), monthlyPrice: money.optional(), annualPrice: money.optional(), currency: currency.optional(), active: z.boolean().optional(),
    features: z.array(trimmed(1, 120)).max(20).optional(),
    limits: z.object({ deliveriesPerMonth: z.number().int().min(0).optional(), reportsPerMonth: z.number().int().min(0).optional() }).optional(),
  }).refine((b) => Object.keys(b).length, 'Nothing to update'),
}), async (req, res) => {
  const updated = await admin.updatePlan(req.valid.params.key, req.valid.body);
  await log(req, 'plan.update', 'plan', updated.key, req.valid.body);
  res.json(ok(updated));
});

router.get('/payments', validate({ query: z.object({ ...pagination, search, status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(), riderId: objectId.optional() }) }), async (req, res) => {
  const { items, meta, totals } = await admin.listPayments(req.valid.query);
  res.json({ success: true, data: items, totals, meta });
});
router.post('/payments', validate({ body: z.object({ riderId: objectId, planKey: z.enum(['starter', 'pro']), billingCycle: z.enum(['monthly', 'annual']), amount: money.optional(), currency: currency.optional(), status: z.enum(['pending', 'succeeded']).optional(), providerRef: z.string().trim().max(120).optional() }) }), async (req, res) => {
  const { riderId, ...rest } = req.valid.body;
  const payment = await payments.recordManual({ ...rest, userId: riderId });
  await log(req, 'payment.record', 'payment', payment._id, { status: payment.status, amount: payment.amount, currency: payment.currency });
  res.status(201).json(ok(admin.serializePayment(payment)));
});
router.patch('/payments/:id', validate({ params: idParams, body: z.object({ status: z.enum(['succeeded', 'failed', 'refunded']) }) }), async (req, res) => {
  const payment = await payments.setStatus(req.valid.params.id, req.valid.body.status);
  await log(req, 'payment.update', 'payment', payment._id, req.valid.body);
  res.json(ok(admin.serializePayment(payment)));
});

/* Settings + audit */
const settingsBody = z.object({
  currencies: z.array(currency).min(1).optional(), defaultCurrency: currency.optional(), trialDays: z.number().int().min(0).max(365).optional(),
  route: z.object({ defaultPreference: preference.optional(), avgSpeedKmh: z.number().min(5).max(120).optional(), stopServiceMinutes: z.number().min(0).max(60).optional() }).optional(),
  reports: z.object({ includePhotos: z.boolean().optional() }).optional(),
  platform: z.object({ name: trimmed(1, 80).optional(), supportEmail: z.union([z.email(), z.literal('')]).optional(), privacyUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional(), paymentInstructions: z.string().trim().max(1000).optional() }).optional(),
  security: z.object({ minPasswordLength: z.number().int().min(6).max(64).optional(), maxFailedLogins: z.number().int().min(3).max(20).optional(), lockoutMinutes: z.number().int().min(1).max(1440).optional() }).optional(),
}).refine((b) => Object.keys(b).length, 'Nothing to update');

router.get('/settings', async (_req, res) => res.json(ok(await getSettings())));
router.put('/settings', validate({ body: settingsBody }), async (req, res) => {
  const updated = await updateSettings(req.valid.body);
  await log(req, 'settings.update', 'settings', 'platform', req.valid.body);
  res.json(ok(updated));
});

router.get('/audit-logs', validate({ query: z.object({ ...pagination, ...range, search, action: z.string().trim().max(60).optional(), status: z.enum(['success', 'failure']).optional() }) }), async (req, res) => {
  const { items, meta } = await admin.listAuditLogs(req.valid.query);
  res.json(ok(items, meta));
});

export default router;
