import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import { RefreshToken } from '../models/refresh-token.js';
import { getSettings } from './settings.service.js';
import { createTrial } from './subscription.service.js';
import { audit } from './audit.service.js';
import { AppError, conflict, forbidden, unauthorized, unprocessable, validationError } from '../utils/errors.js';
import { generateRefreshToken, hashToken, signAccessToken } from '../utils/tokens.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

export const hashPassword = (password) => bcrypt.hash(password, env.BCRYPT_ROUNDS);

export const serializeUser = (u) => ({
  id: String(u._id), fullName: u.fullName, phone: u.phone, email: u.email, role: u.role,
  currency: u.currency, routePreference: u.routePreference, notificationsEnabled: u.notificationsEnabled, status: u.status,
  createdAt: u.createdAt,
});

async function assertPasswordPolicy(password) {
  const { security } = await getSettings();
  if (password.length < security.minPasswordLength) throw validationError([{ path: 'password', message: `Password must be at least ${security.minPasswordLength} characters` }]);
}

/**
 * Creates a rider account. Every rider is fully independent: they sign up on their
 * own, get their own free-trial subscription, and later buy their own plan. There is
 * no organization or team concept anywhere in this app — riders control their own
 * deliveries and subscriptions, full stop.
 * Rolls back on failure (no multi-doc transactions on standalone MongoDB).
 */
export async function createRiderAccount({ fullName, phone, email, password, currency }) {
  await assertPasswordPolicy(password);
  const settings = await getSettings();
  if (!settings.currencies.includes(currency)) throw validationError([{ path: 'currency', message: 'Currency is not enabled' }]);
  if (await User.exists({ email: email.toLowerCase() })) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');

  const userId = new mongoose.Types.ObjectId();
  const created = { user: false, subscription: false };
  try {
    const user = await User.create({
      _id: userId, fullName, phone, email, passwordHash: await hashPassword(password), role: 'rider', currency,
      routePreference: settings.route.defaultPreference,
    });
    created.user = true;
    await createTrial(userId);
    created.subscription = true;
    return user;
  } catch (error) {
    await Promise.allSettled([
      created.user && User.deleteOne({ _id: userId }),
      created.subscription && Subscription.deleteOne({ userId }),
    ]);
    if (error?.code === 11000) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
    throw error;
  }
}

async function issueTokens(user, { family = crypto.randomUUID(), userAgent } = {}) {
  const refreshToken = generateRefreshToken();
  await RefreshToken.create({
    userId: user._id, family, tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000), userAgent: userAgent?.slice(0, 300) || null,
  });
  return { accessToken: signAccessToken(user), expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, refreshToken };
}

export async function register(input, ctx) {
  const user = await createRiderAccount(input);
  const tokens = await issueTokens(user, ctx);
  return { user: serializeUser(user), ...tokens };
}

const CLIENT_ROLE = { mobile: 'rider', web: 'owner_admin' };

export async function login({ email, password, client }, ctx) {
  const settings = await getSettings();
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash +failedLoginCount +lockedUntil');

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ id: user._id, email: user.email }, 'auth.login', { status: 'failure', meta: { reason: 'locked' }, ip: ctx.ip });
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }

  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !valid) {
    if (user) {
      const failed = (user.failedLoginCount || 0) + 1;
      const lock = failed >= settings.security.maxFailedLogins;
      await User.updateOne({ _id: user._id }, { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + settings.security.lockoutMinutes * 60_000) : null });
      if (user.role === 'owner_admin') await audit({ id: user._id, email: user.email }, 'auth.login', { status: 'failure', ip: ctx.ip });
    }
    throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  }

  if (user.status !== 'active') throw forbidden('Your account is suspended. Contact support.', 'ACCOUNT_SUSPENDED');
  if (CLIENT_ROLE[client] !== user.role) {
    throw forbidden(client === 'web' ? 'This console is for platform administrators only.' : 'Please sign in with a rider account.', 'WRONG_CLIENT');
  }

  await User.updateOne({ _id: user._id }, { failedLoginCount: 0, lockedUntil: null, lastActiveAt: new Date() });
  if (user.role === 'owner_admin') await audit({ id: user._id, email: user.email }, 'auth.login', { ip: ctx.ip });
  const tokens = await issueTokens(user, ctx);
  return { user: serializeUser(user), ...tokens };
}

/** Rotating refresh tokens with reuse detection: replaying a used token revokes the whole family. */
export async function refresh(presented, ctx) {
  if (!presented) throw unauthorized('Refresh token required', 'INVALID_REFRESH_TOKEN');
  const record = await RefreshToken.findOne({ tokenHash: hashToken(presented) });
  if (!record) throw unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

  if (record.revokedAt) {
    await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('Refresh token was already used', 'REFRESH_TOKEN_REUSED');
  }
  if (record.expiresAt < new Date()) throw unauthorized('Refresh token expired', 'INVALID_REFRESH_TOKEN');

  const user = await User.findById(record.userId);
  if (!user || user.status !== 'active') throw forbidden('Your account is suspended', 'ACCOUNT_SUSPENDED');

  const next = await issueTokens(user, { family: record.family, userAgent: ctx.userAgent });
  record.revokedAt = new Date();
  record.replacedByHash = hashToken(next.refreshToken);
  await record.save();
  return { user: serializeUser(user), ...next };
}

export async function logout(presented) {
  if (!presented) return;
  const record = await RefreshToken.findOne({ tokenHash: hashToken(presented) });
  if (record) await RefreshToken.updateMany({ family: record.family, revokedAt: null }, { revokedAt: new Date() });
}

export async function getProfile(userId) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized('Account no longer exists', 'INVALID_TOKEN');
  return serializeUser(user);
}

export async function updateProfile(userId, patch) {
  if (patch.currency) {
    const { currencies } = await getSettings();
    if (!currencies.includes(patch.currency)) throw validationError([{ path: 'currency', message: 'Currency is not enabled' }]);
  }
  const user = await User.findByIdAndUpdate(userId, patch, { new: true, runValidators: true });
  return serializeUser(user);
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  await assertPasswordPolicy(newPassword);
  const user = await User.findById(userId).select('+passwordHash');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw unprocessable('Current password is incorrect', 'INVALID_CREDENTIALS');
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() });
}
