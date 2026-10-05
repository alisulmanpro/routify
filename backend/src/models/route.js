import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const stopSchema = new mongoose.Schema(
  {
    deliveryId: { type: ObjectId, ref: 'Delivery', required: true },
    order: { type: Number, required: true },
    legDistanceKm: { type: Number, default: 0 },
    legDurationMin: { type: Number, default: 0 },
  },
  { _id: false },
);

const routeSchema = new mongoose.Schema(
  {
    riderId: { type: ObjectId, ref: 'User', required: true },
    serviceDate: { type: String, required: true },
    preference: { type: String, enum: ['smart', 'nearest_first', 'shortest'], required: true },
    status: { type: String, enum: ['planned', 'active', 'completed'], default: 'planned' },
    origin: { latitude: Number, longitude: Number },
    stops: { type: [stopSchema], default: [] },
    distanceKm: { type: Number, default: 0 },
    durationMin: { type: Number, default: 0 },
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
routeSchema.index({ riderId: 1, status: 1 });
routeSchema.index({ status: 1 });

export const Route = mongoose.models.Route || mongoose.model('Route', routeSchema);
