import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Every rider is fully independent: they sign up, choose a plan, and are billed
// directly. One subscription belongs to exactly one rider (User).
const subscriptionSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    planKey: { type: String, enum: ['trial', 'starter', 'pro'], required: true, index: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    status: { type: String, enum: ['trialing', 'active', 'past_due', 'expired', 'cancelled'], required: true, index: true },
    price: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'USD' },
    startedAt: { type: Date, default: Date.now },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    pending: {
      planKey: { type: String, enum: ['starter', 'pro', null], default: null },
      billingCycle: { type: String, enum: ['monthly', 'annual', null], default: null },
      paymentId: { type: ObjectId, ref: 'Payment', default: null },
    },
  },
  { timestamps: true },
);

export const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
