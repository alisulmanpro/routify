import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

export async function connectDatabase(uri) {
  if (!uri) throw new Error('MONGODB_URI is required');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('MongoDB connected');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export const isDatabaseReady = () => mongoose.connection.readyState === 1;
