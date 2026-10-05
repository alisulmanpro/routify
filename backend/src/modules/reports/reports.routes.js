import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as reports from '../../services/report.service.js';
import { ok, todayKey } from '../../utils/http.js';
import { dateKey, idParams } from '../common/schemas.js';

const router = Router();
router.use(authenticate, authorize('rider'));

router.post('/generate', validate({ body: z.object({ date: dateKey.optional() }).default({}) }), async (req, res) => res.status(201).json(ok(await reports.generate(req.user, req.valid.body.date || todayKey()))));
router.get('/', async (req, res) => res.json(ok(await reports.listMine(req.user))));
router.get('/:id', validate({ params: idParams }), async (req, res) => res.json(ok(reports.serializeReport(await reports.findVisible(req.user, req.valid.params.id)))));

export default router;
