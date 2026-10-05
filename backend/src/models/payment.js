import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// SaaS subscription payments ONLY, always billed directly to the rider. Customer COD
// amounts live on deliveries and are never mixed in here.
const paymentSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, index: true },
    subscriptionId: { type: ObjectId, ref: 'Subscription', default: null },
    planKey: { type: String, enum: ['starter', 'pro'], required: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], required: true },
    amount: { type: Number, min: 0, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: ['pending', 'succeeded', 'failed', 'refunded'], default: 'pending', index: true },
    provider: { type: String, default: 'manual' },
    providerRef: { type: String, default: null },
    paidAt: Date,
  },
  { timestamps: true },
);
paymentSchema.index({ createdAt: -1 });

export const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
