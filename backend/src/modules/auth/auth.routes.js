import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import * as auth from '../../services/auth.service.js';
import { ok } from '../../utils/http.js';
import { currency, phone, trimmed } from '../common/schemas.js';
import { unauthorized } from '../../utils/errors.js';

const router = Router();
const COOKIE = 'dp_rt';
const client = z.enum(['mobile', 'web']).default('mobile');
const password = z.string().min(6).max(128);

const registerBody = z.object({
  fullName: trimmed(2, 120), phone, email: z.email().max(254), password, confirmPassword: z.string(), currency,
}).refine((b) => b.password === b.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });
const loginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(128), client });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional(), client }).default({ client: 'mobile' });
const profileBody = z.object({
  fullName: trimmed(2, 120).optional(), phone: phone.optional(), currency: currency.optional(),
  routePreference: z.enum(['smart', 'nearest_first', 'shortest']).optional(), notificationsEnabled: z.boolean().optional(),
  // A city name sets the rider's service area by hand; null clears it so GPS detection takes over.
  city: z.string().trim().max(120).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const passwordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });

const cookieOptions = () => ({ httpOnly: true, secure: env.cookieSecure, sameSite: env.COOKIE_SAMESITE, path: '/api/v1/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** Web clients get the refresh token as an httpOnly cookie; mobile clients receive it in the JSON body. */
function respond(res, result, clientType, status = 200) {
  const { refreshToken, ...rest } = result;
  if (clientType === 'web') {
    res.cookie(COOKIE, refreshToken, cookieOptions());
    return res.status(status).json(ok(rest));
  }
  return res.status(status).json(ok({ ...rest, refreshToken }));
}

function requireCsrfHeader(req) {
  if (req.cookies?.[COOKIE] && req.get('x-requested-with') !== 'XMLHttpRequest') throw unauthorized('Missing X-Requested-With header', 'CSRF_BLOCKED');
}

router.post('/register', authLimiter, validate({ body: registerBody }), async (req, res) => {
  const { confirmPassword, ...input } = req.valid.body;
  void confirmPassword;
  respond(res, await auth.register(input, ctx(req)), 'mobile', 201);
});

router.post('/login', authLimiter, validate({ body: loginBody }), async (req, res) => {
  respond(res, await auth.login(req.valid.body, ctx(req)), req.valid.body.client);
});

router.post('/refresh', authLimiter, validate({ body: refreshBody }), async (req, res) => {
  const { refreshToken, client: clientType } = req.valid.body;
  let presented = refreshToken;
  if (clientType === 'web') {
    requireCsrfHeader(req);
    presented = req.cookies?.[COOKIE];
  }
  respond(res, await auth.refresh(presented, ctx(req)), clientType);
});

router.post('/logout', validate({ body: refreshBody }), async (req, res) => {
  const { refreshToken, client: clientType } = req.valid.body;
  if (clientType === 'web') requireCsrfHeader(req);
  await auth.logout(clientType === 'web' ? req.cookies?.[COOKIE] : refreshToken);
  if (clientType === 'web') res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json(ok({ loggedOut: true }));
});

router.get('/me', authenticate, async (req, res) => res.json(ok(await auth.getProfile(req.user.id))));
router.patch('/me', authenticate, validate({ body: profileBody }), async (req, res) => res.json(ok(await auth.updateProfile(req.user.id, req.valid.body))));
router.post('/change-password', authLimiter, authenticate, validate({ body: passwordBody }), async (req, res) => {
  await auth.changePassword(req.user.id, req.valid.body);
  res.json(ok({ changed: true }));
});

export default router;
