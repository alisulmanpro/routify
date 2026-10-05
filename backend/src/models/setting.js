import mongoose from 'mongoose';

const settingSchema = new mongoose.Schema({ key: { type: String, unique: true, required: true }, value: { type: mongoose.Schema.Types.Mixed, required: true } }, { timestamps: true });

export const Setting = mongoose.models.Setting || mongoose.model('Setting', settingSchema);
