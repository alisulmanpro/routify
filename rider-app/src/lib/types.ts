export type Currency = 'USD' | 'GBP' | 'EUR' | 'PKR' | 'INR';
export type RoutePreference = 'smart' | 'nearest_first' | 'shortest';

export type ServiceArea = { city: string; country: string | null; countryCode: string; latitude: number; longitude: number; source: 'gps' | 'manual'; confirmedAt: string | null };

export type User = {
  id: string; fullName: string; phone: string; email: string; role: 'rider';
  currency: Currency; routePreference: RoutePreference; notificationsEnabled: boolean; status: string;
  serviceArea: ServiceArea | null;
};

export type PublicConfig = { currencies: Currency[]; defaultCurrency: Currency; routePreference: RoutePreference; minPasswordLength: number; platformName: string; supportEmail: string; privacyUrl: string; paymentInstructions: string };

export type FailureReason = 'customer_unavailable' | 'customer_refused' | 'wrong_address' | 'phone_unreachable' | 'business_closed' | 'other';

export type Delivery = {
  id: string; riderId: string; trackingId: string;
  customer: { name: string; phone: string };
  address: { raw: string; normalized: string | null; latitude: number | null; longitude: number | null; geocoded: boolean; approximate: boolean; geocodeStatus: 'pending' | 'found' | 'approximate' | 'not_found' };
  status: 'pending' | 'in_progress' | 'delivered' | 'failed';
  proof: { photoUrl: string; capturedAt: string } | null;
  note: string | null;
  failure: { reason: FailureReason; note: string | null } | null;
  serviceDate: string; routeId: string | null; stopOrder: number | null;
  arrivedAt: string | null; deliveredAt: string | null; failedAt: string | null; createdAt: string; flags: string[];
};

export type RouteStop = { order: number; legDistanceKm: number; legDurationMin: number; delivery: Delivery };
export type RouteSummary = { total: number; delivered: number; failed: number; pending: number; distanceKm: number; routeMinutes: number | null };
export type Route = {
  id: string; status: 'planned' | 'active' | 'completed'; preference: RoutePreference; serviceDate: string;
  origin: { latitude: number; longitude: number } | null; distanceKm: number; durationMin: number;
  startedAt: string | null; completedAt: string | null; stops: RouteStop[];
  progress: { total: number; done: number; remaining: number }; currentStopId: string | null; summary: RouteSummary;
  /** How the order was optimised: road travel times, or straight-line distance when routing was unavailable. */
  optimization: 'road' | 'straight_line' | null;
  /** Pending stops added after planning, not yet on this route. */
  newStops: number;
};

export type Dashboard = {
  rider: { id: string; fullName: string }; date: string;
  total: number; delivered: number; failed: number; pending: number; distanceKm: number;
  progressPercent: number; routeId: string | null; routeStatus: string | null; nextAction: 'setup' | 'start' | 'continue' | 'complete';
};

export type HistoryDay = { date: string; total: number; delivered: number; failed: number; pending: number; distanceKm: number; hasReport: boolean };

export type ReportRow = { id: string; date: string; summary: Record<string, number | string | null>; downloadUrl: string; viewUrl: string; generatedAt: string; fileSize: number };

export type ImportDraftItem = { trackingId: string; customerName: string; phone: string; address: string; note: string; flags: string[] };
export type ImportDraft = { fileType: string; items: ImportDraftItem[] };

export type Plan = { id: string; key: 'trial' | 'starter' | 'pro'; name: string; monthlyPrice: number; annualPrice: number; currency: string; limits: { deliveriesPerMonth: number; reportsPerMonth: number }; features: string[]; active: boolean };
export type Subscription = { id: string; planKey: 'trial' | 'starter' | 'pro'; billingCycle: 'monthly' | 'annual'; status: string; price: number; currency: string; startedAt: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; pending: { planKey: string; billingCycle: string } | null };
export type SubscriptionInfo = { subscription: Subscription | null; plan: Plan | null; plans: Plan[]; usage: { deliveriesThisMonth: number; reportsThisMonth: number }; paymentInstructions: string };
