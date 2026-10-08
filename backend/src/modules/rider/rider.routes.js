import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as dash from '../../services/rider-dashboard.service.js';
import * as auth from '../../services/auth.service.js';
import { ok, todayKey } from '../../utils/http.js';
import { dateKey } from '../common/schemas.js';

const router = Router();
router.use(authenticate, authorize('rider'));

router.get('/dashboard', validate({ query: z.object({ date: dateKey.optional() }) }), async (req, res) => res.json(ok(await dash.dashboard(req.user, req.valid.query.date || todayKey()))));
router.get('/history', async (req, res) => res.json(ok(await dash.history(req.user))));
const pointQuery = z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) });
// The app checks the rider's city on launch and every few hours: preview first, save once the rider agrees.
router.get('/service-area/detect', validate({ query: pointQuery }), async (req, res) => res.json(ok(await auth.previewServiceArea(req.valid.query))));
router.put('/service-area', validate({ body: pointQuery }), async (req, res) => res.json(ok(await auth.confirmServiceArea(req.user.id, req.valid.body))));
router.delete('/history', async (req, res) => res.json(ok(await dash.clearHistory(req.user))));

export default router;
