const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Cafe API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  describe('GET /api/cafe/me', () => {
    it('returns current cafe details', async () => {
      const res = await request
        .get('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe).toBeDefined();
      expect(res.body.cafe.name).toBe('Test Cafe');
    });
  });

  describe('PUT /api/cafe/me', () => {
    it('updates cafe name', async () => {
      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Cafe Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe.name).toBe('Updated Cafe Name');
    });

    it('updates cafe location', async () => {
      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { address: '123 Main St', city: 'Cape Town' } });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe.location.city).toBe('Cape Town');
    });
  });

  describe('GET /api/cafe/list', () => {
    it('owner sees all org cafes', async () => {
      const res = await request
        .get('/api/cafe/list')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafes).toBeDefined();
      expect(Array.isArray(res.body.cafes)).toBe(true);
      expect(res.body.cafes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
