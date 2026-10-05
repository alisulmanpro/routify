import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import * as routes from '../../services/route.service.js';
import { ok } from '../../utils/http.js';
import { dateKey, idParams, objectId, preference } from '../common/schemas.js';

const router = Router();
router.use(authenticate, authorize('rider'));

const buildBody = z.object({
  preference: preference.optional(),
  origin: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  deliveryIds: z.array(objectId).max(300).optional(), date: dateKey.optional(),
});

router.post('/build', validate({ body: buildBody }), async (req, res) => res.status(201).json(ok(await routes.build(req.user, req.valid.body))));
router.get('/current', async (req, res) => res.json(ok(await routes.getCurrent(req.user))));
router.get('/', async (req, res) => res.json(ok(await routes.listCompleted(req.user))));
router.post('/:id/retry-geocoding', validate({ params: idParams }), async (req, res) => res.json(ok(await routes.retryGeocoding(req.user, req.valid.params.id))));
router.get('/:id', validate({ params: idParams }), async (req, res) => res.json(ok(await routes.getById(req.user, req.valid.params.id))));
router.post('/:id/start', validate({ params: idParams }), async (req, res) => res.json(ok(await routes.start(req.user, req.valid.params.id))));

export default router;
