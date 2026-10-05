import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { isDatabaseReady } from './config/database.js';
import { logger } from './utils/logger.js';
import { requestId } from './middleware/request-id.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { ok } from './utils/http.js';
import authRoutes from './modules/auth/auth.routes.js';
import configRoutes from './modules/config/config.routes.js';
import deliveryRoutes from './modules/deliveries/deliveries.routes.js';
import routeRoutes from './modules/routes/routes.routes.js';
import riderRoutes from './modules/rider/rider.routes.js';
import reportRoutes from './modules/reports/reports.routes.js';
import subscriptionRoutes from './modules/subscriptions/subscriptions.routes.js';
import fileRoutes from './modules/files/files.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info') }));
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || env.corsOrigins.includes(origin)),
    credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'], exposedHeaders: ['X-Request-Id'], maxAge: 600,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json(ok({ status: 'ok', service: 'delivery-planner-api' })));
  app.get('/ready', (_req, res) => (isDatabaseReady() ? res.json(ok({ status: 'ready' })) : res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not connected', details: [] } })));

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/config', configRoutes);
  api.use('/files', fileRoutes);
  api.use('/deliveries', deliveryRoutes);
  api.use('/routes', routeRoutes);
  api.use('/rider', riderRoutes);
  api.use('/reports', reportRoutes);
  api.use('/subscriptions', subscriptionRoutes);
  api.use('/admin', adminRoutes);
  app.use('/api/v1', apiLimiter, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
