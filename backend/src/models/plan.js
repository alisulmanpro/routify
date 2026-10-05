import mongoose from 'mongoose';

const planSchema = new mongoose.Schema(
  {
    key: { type: String, enum: ['trial', 'starter', 'pro'], required: true, unique: true },
    name: { type: String, required: true, trim: true },
    monthlyPrice: { type: Number, min: 0, required: true },
    annualPrice: { type: Number, min: 0, required: true },
    currency: { type: String, default: 'USD' },
    limits: {
      deliveriesPerMonth: { type: Number, min: 0, required: true },
      reportsPerMonth: { type: Number, min: 0, required: true },
    },
    features: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Plan = mongoose.models.Plan || mongoose.model('Plan', planSchema);
