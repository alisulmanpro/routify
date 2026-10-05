// Usage: ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='a-long-password' npm run seed:admin
import { env } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { User } from '../src/models/user.js';
import { hashPassword } from '../src/services/auth.service.js';
import { ensureDefaultPlans } from '../src/services/subscription.service.js';

if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 characters) in the environment.');
  process.exit(1);
}

await connectDatabase(env.MONGODB_URI);
await ensureDefaultPlans();
const email = env.ADMIN_EMAIL.toLowerCase();
const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
const existing = await User.findOne({ email });
if (existing) {
  if (existing.role !== 'owner_admin') { console.error(`${email} exists as a ${existing.role}. Pick another email.`); process.exit(1); }
  existing.passwordHash = passwordHash;
  existing.status = 'active';
  await existing.save();
  console.log(`Updated password for admin ${email}`);
} else {
  await User.create({ fullName: env.ADMIN_NAME, phone: '-', email, passwordHash, role: 'owner_admin' });
  console.log(`Created admin ${email}`);
}
await disconnectDatabase();
