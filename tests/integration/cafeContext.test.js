const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const Event = require('../../src/models/Event.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const cafeOf = (accessToken) => jwt.decode(accessToken).cafeId;

// An owner with Cafe A (from signup) and Cafe B (added), signed in on A. createTestUser returns the login cookie.
const ownerWithTwoCafes = async () => {
  const owner = await createTestUser({ email: 'two-cafes@yourguava.com' });
  const added = await request.post('/api/team/add-cafe').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Cafe B' });
  return { ...owner, cafeA: String(owner.user.activeCafeId), cafeB: String(added.body.cafe._id) };
};

describe('the cafe context belongs to the tab, not the user record', () => {
  it('refresh mints the cafe the tab asked for even after another tab switched, and the write lands there', async () => {
    const owner = await ownerWithTwoCafes();
    const switched = await request.post('/api/team/switch-cafe')
      .set('Authorization', `Bearer ${owner.token}`).send({ cafeId: owner.cafeB });
    expect(switched.status).toBe(200);
    expect(String((await User.findById(owner.user.id).lean()).activeCafeId)).toBe(owner.cafeB);

    const refreshed = await request.post('/api/auth/refresh').set('Cookie', owner.cookie).send({ cafeId: owner.cafeA });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.cafeId).toBe(owner.cafeA);
    expect(cafeOf(refreshed.body.accessToken)).toBe(owner.cafeA);

    const created = await request.post('/api/events')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .set('X-Cafe-Id', owner.cafeA)
      .send({ name: 'Tab one event', date: '2026-10-01' });
    expect(created.status).toBe(201);
    expect(String(created.body.event.cafeId)).toBe(owner.cafeA);
    expect(await Event.countDocuments({ cafeId: owner.cafeB })).toBe(0);
  });

  it('falls back to the user default, and says which, when the tab names no cafe', async () => {
    const owner = await ownerWithTwoCafes();
    await User.updateOne({ _id: owner.user.id }, { $set: { activeCafeId: owner.cafeB } });
    const refreshed = await request.post('/api/auth/refresh').set('Cookie', owner.cookie).send({});
    expect(refreshed.body.cafeId).toBe(owner.cafeB);
    expect(cafeOf(refreshed.body.accessToken)).toBe(owner.cafeB);
  });

  it('returns the cafe it chose when the tab asks for one the user can no longer open', async () => {
    const owner = await ownerWithTwoCafes();
    const manager = await createTestManager(owner.token, [owner.cafeA, owner.cafeB]);
    const managerLogin = await request.post('/api/auth/login')
      .send({ email: 'manager@yourguava.com', password: manager.password });
    await request.patch(`/api/team/${manager.user.id}`)
      .set('Authorization', `Bearer ${owner.token}`).send({ cafeIds: [owner.cafeB] });

    const refreshed = await request.post('/api/auth/refresh')
      .set('Cookie', managerLogin.headers['set-cookie']).send({ cafeId: owner.cafeA });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.cafeId).toBe(owner.cafeB);
    expect(cafeOf(refreshed.body.accessToken)).toBe(owner.cafeB);
  });

  it('ignores malformed cafe ids instead of querying with them', async () => {
    const owner = await ownerWithTwoCafes();
    let cookie = owner.cookie;
    for (const cafeId of [{ $ne: null }, ['x'], 'not-an-id', '', 42, 'aaaaaaaaaaaa']) {
      const res = await request.post('/api/auth/refresh').set('Cookie', cookie).send({ cafeId });
      expect(res.status).toBe(200);
      expect(res.body.cafeId).toBe(owner.cafeA);
      cookie = res.headers['set-cookie'];
    }
  });

  it('refuses a request whose tab cafe disagrees with its token and writes nothing', async () => {
    const owner = await ownerWithTwoCafes();
    const wrong = await request.post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Cafe-Id', owner.cafeB)
      .send({ name: 'Wrong cafe event', date: '2026-10-01' });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toEqual(expect.objectContaining({ code: 'CAFE_CONTEXT_MISMATCH', cafeId: owner.cafeA }));
    expect(await Event.countDocuments()).toBe(0);
  });

  it('reports the session cafe, not the user record, from /auth/me', async () => {
    const owner = await ownerWithTwoCafes();
    await request.post('/api/team/switch-cafe').set('Authorization', `Bearer ${owner.token}`).send({ cafeId: owner.cafeB });
    const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${owner.token}`);
    expect(me.status).toBe(200);
    expect(me.body.activeCafeId).toBe(owner.cafeA);
  });

  it('signs in on a cafe the user can still open when the stored default is stale', async () => {
    const owner = await ownerWithTwoCafes();
    await User.updateOne({ _id: owner.user.id }, { $set: { activeCafeId: 'ffffffffffffffffffffffff' } });
    const login = await request.post('/api/auth/login').send({ email: 'two-cafes@yourguava.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.user.activeCafeId).toBe(owner.cafeA);
    expect(cafeOf(login.body.accessToken)).toBe(owner.cafeA);
    expect((await request.get('/api/cafe/me').set('Authorization', `Bearer ${login.body.accessToken}`)).status).toBe(200);
  });
});
