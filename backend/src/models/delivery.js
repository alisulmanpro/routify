import mongoose from 'mongoose';

export const FAILURE_REASONS = ['customer_unavailable', 'customer_refused', 'wrong_address', 'phone_unreachable', 'business_closed', 'payment_issue', 'other'];
export const DELIVERY_STATUSES = ['pending', 'in_progress', 'delivered', 'failed'];

const { ObjectId } = mongoose.Schema.Types;

const deliverySchema = new mongoose.Schema(
  {
    riderId: { type: ObjectId, ref: 'User', required: true, index: true },
    trackingId: { type: String, required: true, trim: true, maxlength: 80 },
    customer: {
      name: { type: String, required: true, trim: true, maxlength: 160 },
      phone: { type: String, required: true, trim: true, maxlength: 32 },
    },
    address: {
      raw: { type: String, required: true, trim: true, maxlength: 400 },
      normalized: { type: String, default: null },
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      geocoded: { type: Boolean, default: false },
      approximate: { type: Boolean, default: false },
      geocodeStatus: { type: String, enum: ['pending', 'found', 'approximate', 'not_found'], default: 'pending' },
    },
    payment: {
      type: { type: String, enum: ['prepaid', 'cod'], required: true },
      currency: { type: String, default: 'USD' },
      orderValue: { type: Number, min: 0, default: null },
      codAmount: { type: Number, min: 0, default: null },
      codCollectedAmount: { type: Number, min: 0, default: null },
      collectionStatus: { type: String, enum: ['not_required', 'pending', 'collected'], required: true },
    },
    status: { type: String, enum: DELIVERY_STATUSES, default: 'pending' },
    proof: { photoUrl: String, photoKey: String, capturedAt: Date },
    note: { type: String, maxlength: 1000 },
    failure: { reason: { type: String, enum: [...FAILURE_REASONS, null] }, note: { type: String, maxlength: 1000 } },
    serviceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    routeId: { type: ObjectId, ref: 'Route', default: null, index: true },
    stopOrder: { type: Number, default: null },
    arrivedAt: Date,
    deliveredAt: Date,
    failedAt: Date,
  },
  { timestamps: true, optimisticConcurrency: true },
);

// Every rider is independent, so tracking IDs only need to be unique within one rider's own deliveries.
deliverySchema.index({ riderId: 1, trackingId: 1 }, { unique: true });
deliverySchema.index({ riderId: 1, status: 1 });
deliverySchema.index({ riderId: 1, serviceDate: 1 });
deliverySchema.index({ serviceDate: 1, status: 1 });
deliverySchema.index({ createdAt: -1 });

deliverySchema.pre('validate', function enforceBusinessRules() {
  const p = this.payment;
  if (p.type === 'cod') {
    if (!p.codAmount || p.codAmount <= 0) this.invalidate('payment.codAmount', 'COD requires a positive Amount to Collect');
    if (p.collectionStatus !== 'collected') p.collectionStatus = 'pending';
  } else if (p.type === 'prepaid') {
    p.codAmount = null;
    p.codCollectedAmount = null;
    p.collectionStatus = 'not_required';
  }

  if (this.status === 'delivered' && p.type === 'cod' && p.collectionStatus !== 'collected') this.invalidate('payment.collectionStatus', 'COD must be collected before delivery is confirmed');
  if (this.status === 'failed') {
    if (!this.failure?.reason) this.invalidate('failure.reason', 'A failure reason is required');
    if (this.failure?.reason === 'other' && !this.failure?.note?.trim()) this.invalidate('failure.note', 'Please describe the reason for "Other"');
    if (p.type === 'cod' && p.collectionStatus === 'collected') this.invalidate('payment.collectionStatus', 'A failed COD delivery cannot be marked collected');
  }
});

export const Delivery = mongoose.models.Delivery || mongoose.model('Delivery', deliverySchema);
