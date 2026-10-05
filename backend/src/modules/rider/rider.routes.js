import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as dash from '../../services/rider-dashboard.service.js';
import { ok, todayKey } from '../../utils/http.js';
import { dateKey } from '../common/schemas.js';

const router = Router();
router.use(authenticate, authorize('rider'));

router.get('/dashboard', validate({ query: z.object({ date: dateKey.optional() }) }), async (req, res) => res.json(ok(await dash.dashboard(req.user, req.valid.query.date || todayKey()))));
router.get('/history', async (req, res) => res.json(ok(await dash.history(req.user))));

export default router;
