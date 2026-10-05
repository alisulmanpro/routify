import { Router } from 'express';
import * as storage from '../../services/storage.service.js';
import { verifyFileSignature } from '../../utils/signed-url.js';
import { notFound } from '../../utils/errors.js';

const router = Router();

/** Files are private. Access needs a short-lived HMAC-signed URL issued by an authenticated API response. */
router.get('/:kind/:name', async (req, res) => {
  const key = `${req.params.kind}/${req.params.name}`;
  const { exp, sig, d } = req.query;
  if (!verifyFileSignature(key, exp, d, sig)) throw notFound('File');
  const stat = await storage.stat(key);
  res.set({
    'Content-Type': storage.contentTypeFor(key), 'Content-Length': stat.size,
    'Content-Disposition': `${d}; filename="${key.split('/').pop()}"`,
    'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  storage.createReadStream(key).on('error', () => res.destroy()).pipe(res);
});

export default router;
