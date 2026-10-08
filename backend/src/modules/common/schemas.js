import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParams = z.object({ id: objectId });
export const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');
export const pagination = { page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };
export const money = z.number().finite().min(0).max(1_000_000_000);
export const preference = z.enum(['smart', 'nearest_first', 'shortest']);
export const currency = z.enum(['USD', 'GBP', 'EUR', 'PKR', 'INR']);
export const trimmed = (min, max) => z.string().trim().min(min).max(max);
export const phone = z.string().trim().min(5).max(32).regex(/^\+?[\d\s\-()]{5,}$/, 'Enter a valid phone number');
