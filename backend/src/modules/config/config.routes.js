import { Router } from 'express';
import { getPublicConfig } from '../../services/settings.service.js';
import { ok } from '../../utils/http.js';

const router = Router();
router.get('/', async (_req, res) => res.json(ok(await getPublicConfig())));
export default router;
