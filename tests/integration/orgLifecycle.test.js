const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const User = require('../../src/models/User.model');
const Cafe = require('../../src/models/Cafe.model');
const Event = require('../../src/models/Event.model');
const Organization = require('../../src/models/Organization.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

// A Growth org with three locations, two managers and a pending invitation, whose billing has lapsed.
const lapsedGrowthOrg = async () => {
  const owner = await createTestUser({ email: 'lapsed-owner@yourguava.com' });
  const orgId = owner.user.orgId;
  const cafeA = owner.user.activeCafeId;
  const [cafeB, cafeC] = await Cafe.create([{ name: 'Branch B', orgId }, { name: 'Branch C', orgId }]);
  await User.updateOne({ _id: owner.user.id }, { $addToSet: { cafeIds: { $each: [cafeB._id, cafeC._id] } } });
  const [managerOne, managerTwo] = await User.create([
    { name: 'Manager One', email: 'one@yourguava.com', password: 'password123', role: 'manager', orgId, cafeIds: [cafeA], activeCafeId: cafeA },
    {
      name: 'Manager Two', email: 'two@yourguava.com', password: 'password123', role: 'manager', orgId,
      cafeIds: [cafeA, cafeC._id], activeCafeId: cafeC._id,
    },
  ]);
  const invitation = await TeamInvitation.create({
    orgId,
    invitedByUserId: owner.user.id,
    email: 'invitee@yourguava.com',
    name: 'Invitee',
    cafeIds: [cafeB._id],
    tokenHash: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await Organization.updateOne({ _id: orgId }, { $set: { plan: 'growth', billingStatus: 'past_due' } });
  const auth = (req) => req.set('Authorization', `Bearer ${owner.token}`);
  return {
    owner, orgId, auth, managerOne, managerTwo, invitation,
    cafeA: String(cafeA), cafeB: String(cafeB._id), cafeC: String(cafeC._id),
  };
};

describe('a lapsed organisation can reduce what it uses', () => {
  it('sheds a member, an invitation and a location until the Starter checkout succeeds', async () => {
    const org = await lapsedGrowthOrg();
    const checkout = () => org.auth(request.post('/api/account/checkout')).send({ plan: 'starter', billingCycle: 'monthly' });

    const blocked = await checkout();
    expect(blocked.status).toBe(409);
    // checkout's catch answers { success, code, message, capacity } (account.controller.js), as account.test.js asserts.
    expect(blocked.body.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(blocked.body.capacity.locations).toEqual(expect.objectContaining({ used: 3, included: 2, exceeded: true }));

    expect((await org.auth(request.get('/api/team'))).status).toBe(200);
    expect((await org.auth(request.get('/api/cafe/list'))).status).toBe(200);
    expect((await org.auth(request.post('/api/team/switch-cafe')).send({ cafeId: org.cafeA })).status).toBe(200);
    expect((await org.auth(request.delete(`/api/team/${org.managerOne._id}`))).status).toBe(200);
    expect((await org.auth(request.delete(`/api/team/invitations/${org.invitation._id}`))).status).toBe(200);
    const archived = await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`));
    expect(archived.status).toBe(200);
    expect(archived.body.locations.used).toBe(2);

    const paid = await checkout();
    expect(paid.status).toBe(200);
    expect((await Organization.findById(org.orgId).lean()).plan).toBe('starter');
  });

  it('keeps everything else behind the billing gate', async () => {
    const org = await lapsedGrowthOrg();
    for (const [method, url] of [
      ['get', '/api/forecasts/today'],
      ['get', '/api/cafe/me'],
      ['post', '/api/team/invite'],
      ['get', '/api/team/audit-events'],
      ['post', `/api/team/cafes/${org.cafeC}/restore`],
    ]) {
      const res = await org.auth(request[method](url)).send({});
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('BILLING_REQUIRED');
    }
  });
});

describe('archiving a location', () => {
  it('keeps its data, drops it from quotas, lists and access, moves anyone on it, and audits it', async () => {
    const org = await lapsedGrowthOrg();
    await Event.create({ cafeId: org.cafeC, name: 'Closing party', date: new Date('2026-10-01') });
    expect((await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`))).status).toBe(200);

    expect((await Cafe.findById(org.cafeC).lean()).archivedAt).toBeInstanceOf(Date);
    expect(await Event.countDocuments({ cafeId: org.cafeC })).toBe(1);
    const managerTwo = await User.findById(org.managerTwo._id).lean();
    expect(managerTwo.cafeIds.map(String)).toEqual([org.cafeA]);
    expect(String(managerTwo.activeCafeId)).toBe(org.cafeA);
    const list = await org.auth(request.get('/api/cafe/list'));
    expect(list.body.cafes.map((cafe) => String(cafe._id))).not.toContain(org.cafeC);
    const withArchived = await org.auth(request.get('/api/cafe/list').query({ includeArchived: 'true' }));
    expect(withArchived.body.cafes.find((cafe) => String(cafe._id) === org.cafeC).archivedAt).toBeTruthy();
    expect((await org.auth(request.get('/api/account'))).body.account.usage.locations.used).toBe(2);
    expect(await AccessAuditEvent.countDocuments({ action: 'location.archived' })).toBe(1);
  });

  it('revokes an invitation left with no location, and refuses to strand a manager or archive the last location', async () => {
    const org = await lapsedGrowthOrg();
    const stranding = await org.auth(request.post(`/api/team/cafes/${org.cafeA}/archive`));
    expect(stranding.status).toBe(409);
    expect(stranding.body.code).toBe('LOCATION_HAS_MEMBERS');
    expect(stranding.body.message).toMatch(/Manager One/);

    expect((await org.auth(request.post(`/api/team/cafes/${org.cafeB}/archive`))).status).toBe(200);
    expect((await TeamInvitation.findById(org.invitation._id).lean()).status).toBe('revoked');
    expect((await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`))).status).toBe(200);

    const last = await org.auth(request.post(`/api/team/cafes/${org.cafeA}/archive`));
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_LOCATION');
  });

  it('answers 404 for another organisation\'s cafe and for an archived one', async () => {
    const org = await lapsedGrowthOrg();
    const other = await createTestUser({ email: 'other-org@yourguava.com' });
    const foreign = await request.post(`/api/team/cafes/${org.cafeC}/archive`).set('Authorization', `Bearer ${other.token}`);
    expect(foreign.status).toBe(404);
    await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`));
    expect((await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`))).status).toBe(404);
  });

  it('restores an archived location only while billing is current and the plan has room', async () => {
    const org = await lapsedGrowthOrg();
    await org.auth(request.post(`/api/team/cafes/${org.cafeC}/archive`));
    await Organization.updateOne(
      { _id: org.orgId },
      { $set: { plan: 'starter', billingStatus: 'trialing', trialEndsAt: new Date(Date.now() + 86_400_000) } }
    );
    const full = await org.auth(request.post(`/api/team/cafes/${org.cafeC}/restore`));
    expect(full.status).toBe(402);
    expect(full.body.locations).toEqual(expect.objectContaining({ used: 2, included: 2 }));

    expect((await org.auth(request.post(`/api/team/cafes/${org.cafeB}/archive`))).status).toBe(200);
    const restored = await org.auth(request.post(`/api/team/cafes/${org.cafeC}/restore`));
    expect(restored.status).toBe(200);
    expect((await Cafe.findById(org.cafeC).lean()).archivedAt).toBeNull();
    expect((await User.findById(org.owner.user.id).lean()).cafeIds.map(String)).toContain(org.cafeC);
    expect(await AccessAuditEvent.countDocuments({ action: 'location.restored' })).toBe(1);
  });
});
