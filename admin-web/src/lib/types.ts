export type Currency = 'USD' | 'GBP' | 'EUR' | 'PKR' | 'INR';
export type Paginated<T> = { items: T[]; page: number; limit: number; total: number; pages: number };

export type AdminUser = { id: string; fullName: string; email: string; role: 'owner_admin'; status: string };

export type Rider = {
  id: string; fullName: string; email: string; phone: string; status: 'active' | 'suspended'; subscriptionStatus: string | null;
  deliveries: number; prepaid: number; cod: number; codCollected: { currency: string; amount: number }[];
  lastActiveAt: string | null; registeredAt: string;
};

export type Delivery = {
  id: string; riderId: string; trackingId: string;
  customer: { name: string; phone: string }; address: { raw: string; geocoded: boolean; geocodeStatus: string };
  payment: { type: 'prepaid' | 'cod'; currency: string; orderValue: number | null; codAmount: number | null; codCollectedAmount: number | null; collectionStatus: string };
  status: 'pending' | 'in_progress' | 'delivered' | 'failed';
  proof: { photoUrl: string } | null; note: string | null; failure: { reason: string; note: string | null } | null;
  serviceDate: string; createdAt: string; riderName: string | null; flags: string[];
};

export type ReportRow = { id: string; date: string; summary: Record<string, number | string | null>; downloadUrl: string; viewUrl: string; riderName: string | null };

export type Subscription = {
  id: string; userId: string; riderName: string | null;
  planKey: 'trial' | 'starter' | 'pro'; billingCycle: 'monthly' | 'annual';
  status: string; price: number; currency: string; startedAt: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean;
};

export type Plan = { id: string; key: 'trial' | 'starter' | 'pro'; name: string; monthlyPrice: number; annualPrice: number; currency: string; limits: { deliveriesPerMonth: number; reportsPerMonth: number }; features: string[]; active: boolean; subscribers: number };

export type Payment = { id: string; userId: string; riderName: string | null; planKey: string; billingCycle: string; amount: number; currency: string; status: 'pending' | 'succeeded' | 'failed' | 'refunded'; provider: string; providerRef: string | null; paidAt: string | null; createdAt: string };

export type AuditLogRow = { id: string; createdAt: string; actorEmail: string | null; action: string; targetType: string | null; targetId: string | null; status: 'success' | 'failure'; ip: string | null };

export type Settings = {
  currencies: Currency[]; defaultCurrency: Currency; trialDays: number;
  route: { defaultPreference: string; avgSpeedKmh: number; stopServiceMinutes: number };
  reports: { includePhotos: boolean };
  platform: { name: string; supportEmail: string; privacyUrl: string; paymentInstructions: string };
  security: { minPasswordLength: number; maxFailedLogins: number; lockoutMinutes: number };
};

export type Overview = {
  metrics: { riders: number; ridersChangePct: number; activeRiders24h: number; activeRoutes: number; deliveriesToday: number; deliveriesWeek: number; deliveriesChangePct: number; codCollectedToday: { currency: string; amount: number }[]; subscriptionRevenueMonth: { currency: string; amount: number }[] };
  subscriptions: { total: number; active: number; trialing: number; expired: number; pastDue: number; cancelled: number; byPlan: Record<string, number>; byCycle: Record<string, number> };
  paymentMix: { total: number; prepaid: number; cod: number; windowDays: number };
  volume: { date: string; total: number; delivered: number; failed: number }[];
  liveRoutes: { id: string; rider: string; done: number; total: number; startedAt: string }[];
  recentDeliveries: Delivery[];
};
