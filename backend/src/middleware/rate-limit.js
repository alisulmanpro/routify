import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const handler = (_req, res) =>
  res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.', details: [] } });

const make = (windowMs, limit) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler, skip: () => env.isTest });

export const apiLimiter = make(15 * 60 * 1000, 1000);
export const authLimiter = make(15 * 60 * 1000, 40);
export const uploadLimiter = make(15 * 60 * 1000, 120);
