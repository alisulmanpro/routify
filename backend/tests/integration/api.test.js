import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/delivery_planner_test';
process.env.JWT_ACCESS_SECRET ||= 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'b'.repeat(32);
process.env.FILE_SIGNING_SECRET ||= 'c'.repeat(32);
process.env.STORAGE_DIR = './tests/tmp-uploads';

const { createApp } = await import('../../src/app.js');
const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
const { ensureDefaultPlans } = await import('../../src/services/subscription.service.js');
const { setGeocoderForTests, setAreaResolverForTests } = await import('../../src/services/geocoding.service.js');

let app;

before(async () => {
  await connectDatabase(process.env.MONGODB_URI);
  await mongoose.connection.db.dropDatabase();
  await ensureDefaultPlans();
  app = createApp();
});

after(async () => {
  await disconnectDatabase();
});

test('rejects weak passwords and enforces email uniqueness', async () => {
  const weak = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'A B', phone: '+92 300 1112223', email: 'weak@example.com', password: '123', confirmPassword: '123', currency: 'USD' });
  assert.equal(weak.status, 400);

  const ok1 = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'A B', phone: '+92 300 1112223', email: 'dup@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  assert.equal(ok1.status, 201);

  const dup = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'A B', phone: '+92 300 1112223', email: 'dup@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');
});

test('a delivery needs only a parcel ID and address; payment details are no longer stored', async () => {
  const reg = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Rider One', phone: '+92 300 1112224', email: 'rider1@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'PKR' });
  const auth = `Bearer ${reg.body.data.accessToken}`;

  const minimal = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'T-1', address: { raw: 'Somewhere real enough' } });
  assert.equal(minimal.status, 201);
  assert.equal(minimal.body.data.customer.name, '');
  assert.equal(minimal.body.data.customer.phone, '');

  // Older clients may still send payment; it is ignored rather than rejected.
  const legacy = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'T-2', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Somewhere real enough' }, payment: { type: 'cod' } });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.data.payment, undefined);

  const noAddress = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'T-3' });
  assert.equal(noAddress.status, 400);
});

test('a rider cannot see another organization delivery; duplicate tracking IDs are rejected', async () => {
  const r1 = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Org1 Rider', phone: '+92 300 5551111', email: 'org1@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const r2 = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Org2 Rider', phone: '+92 300 5552222', email: 'org2@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth1 = `Bearer ${r1.body.data.accessToken}`;
  const auth2 = `Bearer ${r2.body.data.accessToken}`;

  const created = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth1).send({ trackingId: 'ISO-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Real address here' } });
  assert.equal(created.status, 201);

  const cross = await supertest(app).get(`/api/v1/deliveries/${created.body.data.id}`).set('Authorization', auth2);
  assert.equal(cross.status, 404);

  const dup = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth1).send({ trackingId: 'ISO-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Real address here' } });
  assert.equal(dup.status, 409);
});

test('delivery can be marked delivered without a proof photo, and route lifecycle gates work', async () => {
  const r = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Flow Rider', phone: '+92 300 7778888', email: 'flow@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${r.body.data.accessToken}`;
  const d = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'FLOW-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Real address here' } });
  const id = d.body.data.id;

  const arriveBeforeRoute = await supertest(app).post(`/api/v1/deliveries/${id}/arrive`).set('Authorization', auth);
  assert.equal(arriveBeforeRoute.status, 409);
  assert.equal(arriveBeforeRoute.body.error.code, 'ROUTE_NOT_ACTIVE');

  const route = await supertest(app).post('/api/v1/routes/build').set('Authorization', auth).send({});
  assert.equal(route.status, 201);
  const start = await supertest(app).post(`/api/v1/routes/${route.body.data.id}/start`).set('Authorization', auth);
  assert.equal(start.status, 200);

  await supertest(app).post(`/api/v1/deliveries/${id}/arrive`).set('Authorization', auth);
  const deliverNoProof = await supertest(app).post(`/api/v1/deliveries/${id}/deliver`).set('Authorization', auth).send({});
  assert.equal(deliverNoProof.status, 200);
  assert.equal(deliverNoProof.body.data.status, 'delivered');
});

test('delivery order guard requires explicit confirmation to complete a later route stop first', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Order Rider', phone: '+92 300 1112233', email: 'order-rider@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${rider.body.data.accessToken}`;
  const items = ['ORDER-1', 'ORDER-2'].map((trackingId) => ({ trackingId, customer: { name: 'C', phone: '03001112223' }, address: { raw: `Real address for ${trackingId}` } }));
  const created = await supertest(app).post('/api/v1/deliveries/bulk').set('Authorization', auth).send({ items });
  assert.equal(created.status, 201);

  const route = await supertest(app).post('/api/v1/routes/build').set('Authorization', auth).send({ deliveryIds: created.body.data.map((d) => d.id) });
  assert.equal(route.status, 201);
  const laterStopId = route.body.data.stops[1].delivery.id;
  await supertest(app).post(`/api/v1/routes/${route.body.data.id}/start`).set('Authorization', auth);
  await supertest(app).post(`/api/v1/deliveries/${laterStopId}/arrive`).set('Authorization', auth);

  const blocked = await supertest(app).post(`/api/v1/deliveries/${laterStopId}/deliver`).set('Authorization', auth).send({});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'EARLIER_STOPS_REMAIN');

  const confirmed = await supertest(app).post(`/api/v1/deliveries/${laterStopId}/deliver`).set('Authorization', auth).send({ allowSkip: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.status, 'delivered');
});

test('planned route refresh retries unresolved addresses and updates stop coordinates', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Geocode Rider', phone: '+92 300 1112266', email: 'geocode-rider@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${rider.body.data.accessToken}`;
  const created = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'GEO-RETRY-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'DHQ Hospital Narowal' } });
  assert.equal(created.status, 201);

  try {
    setGeocoderForTests(async () => null);
    const route = await supertest(app).post('/api/v1/routes/build').set('Authorization', auth).send({});
    assert.equal(route.status, 201);
    assert.equal(route.body.data.stops[0].delivery.address.geocodeStatus, 'not_found');

    // A retry first finds only the general area: the stop gets coordinates but stays flagged.
    setGeocoderForTests(async () => ({ latitude: 32.1009, longitude: 74.8722, normalized: 'Narowal, Pakistan', approximate: true }));
    const approximate = await supertest(app).post(`/api/v1/routes/${route.body.data.id}/retry-geocoding`).set('Authorization', auth);
    assert.equal(approximate.status, 200);
    assert.equal(approximate.body.data.stops[0].delivery.address.geocoded, false);
    assert.equal(approximate.body.data.stops[0].delivery.address.approximate, true);
    assert.equal(approximate.body.data.stops[0].delivery.address.latitude, 32.1009);
    assert.ok(approximate.body.data.stops[0].delivery.flags.includes('approximate_location'));

    // Retries look approximate stops up again, so a later exact match upgrades the stop.
    setGeocoderForTests(async () => ({ latitude: 32.0983, longitude: 74.8735, normalized: 'DHQ Hospital, Narowal, Pakistan', approximate: false }));
    const refreshed = await supertest(app).post(`/api/v1/routes/${route.body.data.id}/retry-geocoding`).set('Authorization', auth);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.stops[0].delivery.address.geocoded, true);
    assert.equal(refreshed.body.data.stops[0].delivery.address.geocodeStatus, 'found');
    assert.equal(refreshed.body.data.stops[0].delivery.address.latitude, 32.0983);
    assert.ok(!refreshed.body.data.stops[0].delivery.flags.includes('approximate_location'));
  } finally {
    setGeocoderForTests();
  }
});

test('other delivery failure requires and accepts a description', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Failure Rider', phone: '+92 300 1112244', email: 'failure-rider@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${rider.body.data.accessToken}`;
  const created = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'FAIL-OTHER-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Real address for failure test' } });
  const route = await supertest(app).post('/api/v1/routes/build').set('Authorization', auth).send({});
  await supertest(app).post(`/api/v1/routes/${route.body.data.id}/start`).set('Authorization', auth);
  await supertest(app).post(`/api/v1/deliveries/${created.body.data.id}/arrive`).set('Authorization', auth);

  const missingNote = await supertest(app).post(`/api/v1/deliveries/${created.body.data.id}/fail`).set('Authorization', auth).send({ reason: 'other' });
  assert.equal(missingNote.status, 400);

  const withNote = await supertest(app).post(`/api/v1/deliveries/${created.body.data.id}/fail`).set('Authorization', auth).send({ reason: 'other', note: 'Gate was locked' });
  assert.equal(withNote.status, 200);
  assert.equal(withNote.body.data.failure.note, 'Gate was locked');
});

test('rider can generate a report for a past service date', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Report Rider', phone: '+92 300 1112255', email: 'report-rider@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${rider.body.data.accessToken}`;
  const pastDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const created = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'REPORT-PAST-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Real address for report test' }, serviceDate: pastDate });
  assert.equal(created.status, 201);

  const report = await supertest(app).post('/api/v1/reports/generate').set('Authorization', auth).send({ date: pastDate });
  assert.equal(report.status, 201);
  assert.equal(report.body.data.date, pastDate);
});

test('admin cannot be created via /auth/register and rider cannot reach /admin routes', async () => {
  const r = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'No Admin', phone: '+92 300 1119999', email: 'noadmin@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  assert.equal(r.body.data.user.role, 'rider');

  const forbidden = await supertest(app).get('/api/v1/admin/overview').set('Authorization', `Bearer ${r.body.data.accessToken}`);
  assert.equal(forbidden.status, 403);

  const anon = await supertest(app).get('/api/v1/admin/overview');
  assert.equal(anon.status, 401);
});

test('self-registered riders get their own individual subscription and control their own deliveries', async () => {
  const r = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Solo Rider', phone: '+92 300 6661111', email: 'solo@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.user.organizationId, undefined, 'the user object must not expose any organization concept');
  const auth = `Bearer ${r.body.data.accessToken}`;

  const me = await supertest(app).get('/api/v1/subscriptions/me').set('Authorization', auth);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.subscription.userId, r.body.data.user.id);
  assert.equal(me.body.data.subscription.planKey, 'trial');

  const delivery = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'SOLO-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Somewhere real enough' } });
  assert.equal(delivery.status, 201);
  assert.equal(delivery.body.data.riderId, r.body.data.user.id);
});

test('two different riders can use the same tracking ID without colliding with each other', async () => {
  const a = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Rider A', phone: '+92 300 7771111', email: 'ridera@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const b = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Rider B', phone: '+92 300 7772222', email: 'riderb@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const authA = `Bearer ${a.body.data.accessToken}`;
  const authB = `Bearer ${b.body.data.accessToken}`;

  const dA = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', authA).send({ trackingId: 'SHARED-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Somewhere real enough' } });
  const dB = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', authB).send({ trackingId: 'SHARED-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Somewhere else entirely' } });
  assert.equal(dA.status, 201);
  assert.equal(dB.status, 201, 'a different rider must be able to reuse the same tracking ID');
});

test('a rider hits their plan delivery limit independently of everyone else', async () => {
  const r = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Limit Rider', phone: '+92 300 8881111', email: 'limit@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${r.body.data.accessToken}`;

  const { Plan } = await import('../../src/models/plan.js');
  await Plan.updateOne({ key: 'trial' }, { 'limits.deliveriesPerMonth': 2 });

  const items = [
    { trackingId: 'LIM-1', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Addr 1' } },
    { trackingId: 'LIM-2', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Addr 2' } },
  ];
  const ok1 = await supertest(app).post('/api/v1/deliveries/bulk').set('Authorization', auth).send({ items });
  assert.equal(ok1.status, 201);

  const blocked = await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'LIM-3', customer: { name: 'C', phone: '03001112223' }, address: { raw: 'Addr 3' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PLAN_LIMIT_REACHED');

  await Plan.updateOne({ key: 'trial' }, { 'limits.deliveriesPerMonth': 100 });
});

test('pending plan upgrades show the upcoming paid plan in the rider subscription summary', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Pending Rider', phone: '+92 300 3334444', email: 'pending@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const auth = `Bearer ${rider.body.data.accessToken}`;

  const request = await supertest(app).post('/api/v1/subscriptions').set('Authorization', auth).send({ planKey: 'starter', billingCycle: 'monthly' });
  assert.equal(request.status, 201);

  const me = await supertest(app).get('/api/v1/subscriptions/me').set('Authorization', auth);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.subscription.planKey, 'trial');
  assert.equal(me.body.data.subscription.pending.planKey, 'starter');
  assert.equal(me.body.data.plan.name, 'Starter');
  assert.match(me.body.data.plan.name, /Starter/);
});

test('admin console works entirely off riders — there is no organization concept anywhere', async () => {
  const { User } = await import('../../src/models/user.js');
  const { hashPassword } = await import('../../src/services/auth.service.js');
  const adminEmail = 'ov-admin@example.com';
  await User.create({ fullName: 'Overview Admin', phone: '-', email: adminEmail, passwordHash: await hashPassword('longenough1'), role: 'owner_admin' });
  const login = await supertest(app).post('/api/v1/auth/login').send({ email: adminEmail, password: 'longenough1', client: 'web' });
  assert.equal(login.status, 200);
  const auth = `Bearer ${login.body.data.accessToken}`;

  const overview = await supertest(app).get('/api/v1/admin/overview').set('Authorization', auth);
  assert.equal(overview.status, 200);
  assert.ok(overview.body.data.metrics.riders >= 1);
  assert.equal(overview.body.data.metrics.organizations, undefined);

  const riders = await supertest(app).get('/api/v1/admin/riders').set('Authorization', auth).query({ limit: 5 });
  assert.equal(riders.status, 200);
  assert.ok(riders.body.data.every((r) => r.organizationId === undefined));

  const noOrgRoutes = await supertest(app).get('/api/v1/admin/organizations').set('Authorization', auth);
  assert.equal(noOrgRoutes.status, 404, 'the /admin/organizations endpoint must no longer exist');
});

test('admin can record a manual payment directly against a rider and activate their subscription', async () => {
  const { User } = await import('../../src/models/user.js');
  const { hashPassword } = await import('../../src/services/auth.service.js');
  const adminEmail = 'pay-admin@example.com';
  await User.create({ fullName: 'Pay Admin', phone: '-', email: adminEmail, passwordHash: await hashPassword('longenough1'), role: 'owner_admin' });
  const adminLogin = await supertest(app).post('/api/v1/auth/login').send({ email: adminEmail, password: 'longenough1', client: 'web' });
  const adminAuth = `Bearer ${adminLogin.body.data.accessToken}`;

  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Paying Rider', phone: '+92 300 4443333', email: 'paying@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'USD' });
  const riderId = rider.body.data.user.id;

  const payment = await supertest(app).post('/api/v1/admin/payments').set('Authorization', adminAuth).send({ riderId, planKey: 'starter', billingCycle: 'monthly', status: 'succeeded' });
  assert.equal(payment.status, 201);
  assert.equal(payment.body.data.userId, riderId);

  const me = await supertest(app).get('/api/v1/subscriptions/me').set('Authorization', `Bearer ${rider.body.data.accessToken}`);
  assert.equal(me.body.data.subscription.planKey, 'starter');
  assert.equal(me.body.data.subscription.status, 'active');
});

test('rider confirms a detected city and address lookups are scoped to it', async () => {
  const rider = await supertest(app).post('/api/v1/auth/register').send({ fullName: 'Area Rider', phone: '+44 7700 900123', email: 'area-rider@example.com', password: 'longenough1', confirmPassword: 'longenough1', currency: 'GBP' });
  const auth = `Bearer ${rider.body.data.accessToken}`;
  const london = { city: 'London', country: 'United Kingdom', countryCode: 'gb', latitude: 51.5072, longitude: -0.1276 };
  const seenAreas = [];
  try {
    setAreaResolverForTests(async () => london);
    const detected = await supertest(app).get('/api/v1/rider/service-area/detect').query({ latitude: 51.5072, longitude: -0.1276 }).set('Authorization', auth);
    assert.equal(detected.status, 200);
    assert.equal(detected.body.data.city, 'London');

    const before = await supertest(app).get('/api/v1/auth/me').set('Authorization', auth);
    assert.equal(before.body.data.serviceArea, null, 'detecting alone must not save the city');

    const confirmed = await supertest(app).put('/api/v1/rider/service-area').send({ latitude: 51.5072, longitude: -0.1276 }).set('Authorization', auth);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.serviceArea.city, 'London');
    assert.equal(confirmed.body.data.serviceArea.source, 'gps');

    setGeocoderForTests(async (address, area) => { seenAreas.push(area); return { latitude: 51.51, longitude: -0.12, normalized: 'London', approximate: false }; });
    await supertest(app).post('/api/v1/deliveries/manual').set('Authorization', auth).send({ trackingId: 'AREA-1', customer: { name: 'C', phone: '07700900124' }, address: { raw: '10 Downing Street' } });
    const route = await supertest(app).post('/api/v1/routes/build').set('Authorization', auth).send({});
    assert.equal(route.status, 201);
    assert.equal(seenAreas[0]?.countryCode, 'gb');
    assert.equal(seenAreas[0]?.city, 'London');

    const cleared = await supertest(app).patch('/api/v1/auth/me').send({ city: null }).set('Authorization', auth);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.serviceArea, null);
  } finally {
    setGeocoderForTests();
    setAreaResolverForTests(null);
  }
});
