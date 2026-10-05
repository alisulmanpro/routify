import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  FILE_SIGNING_SECRET: z.string().min(32, 'FILE_SIGNING_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  COOKIE_SECURE: bool.optional(),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

  STORAGE_DIR: z.string().default('./uploads'),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  GEOCODING_PROVIDER: z.enum(['nominatim', 'google', 'none']).default('nominatim'),
  GEOCODING_USER_AGENT: z.string().optional(),
  GEOCODING_COUNTRY: z.string().trim().default('Pakistan'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ADMIN_NAME: z.string().default('Platform Admin'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${lines}\nSee backend/.env.example`);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';

if (raw.GEOCODING_PROVIDER === 'nominatim' && !raw.GEOCODING_USER_AGENT && isProduction) {
  throw new Error('GEOCODING_USER_AGENT is required for Nominatim (identify your app + contact email)');
}
if (raw.GEOCODING_PROVIDER === 'google' && !raw.GOOGLE_MAPS_API_KEY) {
  throw new Error('GOOGLE_MAPS_API_KEY is required when GEOCODING_PROVIDER=google');
}
if (isProduction && raw.COOKIE_SAMESITE === 'none' && raw.COOKIE_SECURE === false) {
  throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
}

export const env = {
  ...raw,
  isProduction,
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: raw.COOKIE_SECURE ?? isProduction,
};
