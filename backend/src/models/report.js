import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const reportSchema = new mongoose.Schema(
  {
    riderId: { type: ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    summary: {
      total: Number, delivered: Number, failed: Number, pending: Number,
      distanceKm: Number, routeMinutes: Number,
    },
    fileKey: { type: String, required: true },
    fileSize: Number,
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
reportSchema.index({ riderId: 1, date: 1 }, { unique: true });
reportSchema.index({ date: -1 });

export const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);
