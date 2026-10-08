import mongoose from 'mongoose';

export const CURRENCIES = ['USD', 'GBP', 'EUR', 'PKR', 'INR'];
export const ROUTE_PREFERENCES = ['smart', 'nearest_first', 'shortest'];

// The city a rider delivers in. Address lookups are scoped to it so short fragments like
// "passport office" can't match a place on another continent.
const serviceAreaSchema = new mongoose.Schema(
  {
    city: { type: String, required: true, trim: true, maxlength: 120 },
    country: { type: String, trim: true, maxlength: 120 },
    countryCode: { type: String, required: true, lowercase: true, minlength: 2, maxlength: 2 },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    source: { type: String, enum: ['gps', 'manual'], required: true },
    confirmedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['rider', 'owner_admin'], required: true, index: true },
    currency: { type: String, enum: CURRENCIES, default: 'USD' },
    routePreference: { type: String, enum: ROUTE_PREFERENCES, default: 'smart' },
    notificationsEnabled: { type: Boolean, default: true },
    serviceArea: { type: serviceAreaSchema, default: null },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = mongoose.models.User || mongoose.model('User', userSchema);
