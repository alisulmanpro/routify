import mongoose from 'mongoose';

const cacheSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  found: { type: Boolean, required: true },
  latitude: Number,
  longitude: Number,
  normalized: String,
  approximate: { type: Boolean, default: false },
  provider: String,
  expiresAt: { type: Date, required: true },
});
cacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GeocodeCache = mongoose.models.GeocodeCache || mongoose.model('GeocodeCache', cacheSchema);
