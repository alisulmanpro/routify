import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as subs from '../../services/subscription.service.js';
import { ok } from '../../utils/http.js';

const router = Router();
router.use(authenticate, authorize('rider'));

router.get('/me', async (req, res) => res.json(ok(await subs.getMine(req.user))));
router.post('/', validate({ body: z.object({ planKey: z.enum(['starter', 'pro']), billingCycle: z.enum(['monthly', 'annual']) }) }), async (req, res) => res.status(201).json(ok(await subs.requestChange(req.user, req.valid.body))));
router.post('/cancel', async (req, res) => res.json(ok(await subs.cancelAtPeriodEnd(req.user))));

export default router;
