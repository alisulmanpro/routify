import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const body = (code, message, details = []) => ({ success: false, error: { code, message, details } });

export function notFoundHandler(_req, res) {
  res.status(404).json(body('NOT_FOUND', 'The requested resource was not found'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) return res.status(error.status).json(body(error.code, error.message, error.details));

  if (error instanceof ZodError) {
    return res.status(400).json(body('VALIDATION_ERROR', 'Validation failed', error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((e) => ({ path: e.path, message: e.message }));
    return res.status(400).json(body('VALIDATION_ERROR', details[0]?.message || 'Validation failed', details));
  }
  if (error instanceof mongoose.Error.VersionError) return res.status(409).json(body('CONFLICT', 'This record was changed by someone else. Refresh and try again.'));
  if (error instanceof mongoose.Error.CastError) return res.status(400).json(body('BAD_REQUEST', `Invalid value for ${error.path}`));
  if (error?.code === 11000) return res.status(409).json(body('DUPLICATE', 'A record with these details already exists', [{ fields: Object.keys(error.keyPattern || {}) }]));
  if (error?.name === 'MulterError') {
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json(body(tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR', tooBig ? 'The uploaded file is too large' : error.message));
  }
  if (error?.type === 'entity.parse.failed') return res.status(400).json(body('BAD_REQUEST', 'Request body is not valid JSON'));
  if (error?.type === 'entity.too.large') return res.status(413).json(body('PAYLOAD_TOO_LARGE', 'Request body is too large'));

  (req.log || logger).error({ err: error, requestId: req.id }, 'Unhandled error');
  return res.status(500).json(body('INTERNAL_ERROR', 'The server could not complete the request'));
}
