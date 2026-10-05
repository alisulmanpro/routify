import { User } from '../models/user.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { forbidden, unauthorized } from '../utils/errors.js';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Verifies the bearer token and re-checks the account on every request. */
export async function authenticate(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  const claims = verifyAccessToken(token);
  const user = await User.findById(claims.sub).select('fullName email role status lastActiveAt').lean();
  if (!user) throw unauthorized('Account no longer exists', 'INVALID_TOKEN');
  if (user.status !== 'active') throw forbidden('Your account is suspended', 'ACCOUNT_SUSPENDED');

  req.user = { id: String(user._id), role: user.role, email: user.email, fullName: user.fullName };

  if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > TOUCH_INTERVAL_MS) {
    User.updateOne({ _id: user._id }, { lastActiveAt: new Date() }).catch(() => {});
  }
  next();
}

export const authorize = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) throw forbidden();
  next();
};
