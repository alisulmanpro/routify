export type RoutePreference = 'smart' | 'nearest_first' | 'shortest';

export type ServiceArea = { city: string; country: string | null; countryCode: string; latitude: number; longitude: number; source: 'gps' | 'manual'; confirmedAt: string | null };

export type User = {
  id: string; fullName: string; phone: string; email: string; role: 'rider';
  routePreference: RoutePreference; notificationsEnabled: boolean; status: string;
  serviceArea: ServiceArea | null;
};

export type PublicConfig = {
  routePreference: RoutePreference; minPasswordLength: number; platformName: string; supportEmail: string; privacyUrl: string; paymentInstructions: string; trialDays: number;
  /** Below this app version the app must be updated before it can be used; below latestAppVersion an update is suggested. */
  minAppVersion?: string; latestAppVersion?: string; storeUrls?: { android: string | null; ios: string | null };
};

export type FailureReason = 'customer_unavailable' | 'customer_refused' | 'wrong_address' | 'phone_unreachable' | 'business_closed' | 'other';

export type Delivery = {
  id: string; riderId: string; trackingId: string;
  customer: { name: string; phone: string };
  address: {
    raw: string; normalized: string | null; latitude: number | null; longitude: number | null; geocoded: boolean; approximate: boolean;
    geocodeStatus: 'pending' | 'found' | 'approximate' | 'not_found';
    /** The Eircode ("D01 F5P2") or other postcode; null when none is known (e.g. stops added before postcodes were kept). */
    postalCode: string | null;
  };
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
  id: string; name: string | null; status: 'planned' | 'active' | 'completed'; preference: RoutePreference; serviceDate: string;
  origin: { latitude: number; longitude: number } | null; distanceKm: number; durationMin: number;
  startedAt: string | null; completedAt: string | null; stops: RouteStop[];
  progress: { total: number; done: number; remaining: number }; currentStopId: string | null; summary: RouteSummary;
  /** How the order was optimised: road travel times, or straight-line distance when routing was unavailable. */
  optimization: 'road' | 'straight_line' | null;
  /** Pending stops added after planning, not yet on this route. */
  newStops: number;
};

/** A route without its stops, from GET /routes/by-date (e.g. the Home day selector). */
export type RouteListItem = Pick<Route, 'id' | 'name' | 'status' | 'preference' | 'serviceDate' | 'distanceKm' | 'durationMin' | 'startedAt' | 'completedAt' | 'progress' | 'summary'>;

/** Open stops left from days before today (GET /routes/leftover), latest day first. */
export type LeftOver = { total: number; days: { date: string; count: number }[] };

export type Dashboard = {
  rider: { id: string; fullName: string }; date: string;
  total: number; delivered: number; failed: number; pending: number; distanceKm: number;
  progressPercent: number; routeId: string | null; routeStatus: string | null; nextAction: 'setup' | 'start' | 'continue' | 'complete';
};

export type HistoryDay = { date: string; total: number; delivered: number; failed: number; pending: number; distanceKm: number; hasReport: boolean };

export type ReportRow = { id: string; date: string; summary: Record<string, number | string | null>; downloadUrl: string; viewUrl: string; generatedAt: string; fileSize: number };

/** A matching address for what the rider typed, from POST /deliveries/geocode-suggest. */
export type AddressSuggestion = { label: string; latitude: number; longitude: number; approximate: boolean };
/** POST /deliveries/geocode-check: the map's match for an address, without saving anything. */
export type GeocodeCheck = { found: boolean; approximate: boolean; latitude: number | null; longitude: number | null; normalized: string | null; postalCode: string | null };

export type ImportDraftItem = { trackingId: string; customerName: string; phone: string; address: string; note: string; flags: string[] };
export type ImportDraft = { fileType: string; items: ImportDraftItem[] };

export type Plan = { id: string; key: 'trial' | 'starter' | 'pro'; name: string; monthlyPrice: number; annualPrice: number; currency: string; limits: { deliveriesPerMonth: number; reportsPerMonth: number }; features: string[]; active: boolean };
export type Subscription = { id: string; planKey: 'trial' | 'starter' | 'pro'; billingCycle: 'monthly' | 'annual'; status: string; price: number; currency: string; startedAt: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; pending: { planKey: string; billingCycle: string } | null; storeManaged: boolean };
export type StoreName = 'apple' | 'google' | 'revenuecat' | 'mock';
export type PaidPlanKey = 'starter' | 'pro';
export type BillingCycle = 'monthly' | 'annual';
/** The store purchase billing the plan (null when the plan is not billed through a store). */
export type StorePurchase = { store: StoreName; productId: string; status: 'active' | 'grace' | 'past_due'; autoRenew: boolean; expiresAt: string; testMode: boolean };
export type SubscriptionInfo = { subscription: Subscription | null; store: StorePurchase | null; plan: Plan | null; plans: Plan[]; usage: { deliveriesThisMonth: number; reportsThisMonth: number }; paymentInstructions: string };
export type StoreProduct = { productId: string; basePlanId?: string; trialOfferId?: string; planKey: PaidPlanKey; billingCycle: BillingCycle };
export type StoreConfig = { stores: StoreName[]; accountToken: string; products: Partial<Record<StoreName, StoreProduct[]>>; trialEligible: Partial<Record<StoreName, boolean>>; trialDays: number; entitlement?: string };
