const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Team API', () => {
  let ownerToken;
  let ownerUser;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;
  });

  describe('POST /api/team/invite', () => {
    it('owner invites a manager successfully', async () => {
      const cafeId = ownerUser.activeCafeId;

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'New Manager',
          email: 'manager@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.manager).toBeDefined();
      expect(res.body.manager.email).toBe('manager@yourguava.com');
      expect(res.body.manager.role).toBe('manager');
    });

    it('manager cannot invite (403)', async () => {
      const cafeId = ownerUser.activeCafeId;

      // Create manager first
      const manager = await createTestManager(ownerToken, [cafeId]);

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${manager.token}`)
        .send({
          name: 'Another Manager',
          email: 'another@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/team', () => {
    it('lists team members', async () => {
      const cafeId = ownerUser.activeCafeId;

      // Invite a manager
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Team Member',
          email: 'team@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      const res = await request
        .get('/api/team')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.members).toBeDefined();
      // Owner + Manager = 2 members
      expect(res.body.members.length).toBe(2);
    });
  });

  describe('POST /api/team/switch-cafe', () => {
    it('switches active cafe and returns new token', async () => {
      // Add a second cafe
      const addRes = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Second Cafe' });

      const secondCafeId = addRes.body.cafe._id;

      const res = await request
        .post('/api/team/switch-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ cafeId: secondCafeId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.activeCafeId).toBe(secondCafeId);
    });
  });

  describe('POST /api/team/add-cafe', () => {
    it('adds new cafe to org', async () => {
      const res = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'New Branch' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe).toBeDefined();
      expect(res.body.cafe.name).toBe('New Branch');
    });
  });

  describe('DELETE /api/team/:id', () => {
    it('removes manager from org', async () => {
      const cafeId = ownerUser.activeCafeId;

      // Invite a manager
      const inviteRes = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'To Remove',
          email: 'remove@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      const managerId = inviteRes.body.manager.id;

      const res = await request
        .delete(`/api/team/${managerId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/removed/i);
    });
  });
});
