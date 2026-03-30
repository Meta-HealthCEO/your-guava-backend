const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Events API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
  });

  describe('POST /api/events', () => {
    it('creates an event', async () => {
      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Jazz Night',
          date: '2026-04-15',
          impact: 'high',
          notes: 'Live music event',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.event).toBeDefined();
      expect(res.body.event.name).toBe('Jazz Night');
      expect(res.body.event.impact).toBe('high');
    });

    it('returns 400 when name or date is missing', async () => {
      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ impact: 'low' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/events', () => {
    it('lists events for the cafe', async () => {
      // Create some events
      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Event 1', date: '2026-12-01', impact: 'low' });

      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Event 2', date: '2026-12-15', impact: 'high' });

      const res = await request
        .get('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-12-01', to: '2026-12-31' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.events.length).toBe(2);
    });
  });

  describe('DELETE /api/events/:id', () => {
    it('deletes an event', async () => {
      const createRes = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'To Delete', date: '2026-05-01' });

      const eventId = createRes.body.event._id;

      const res = await request
        .delete(`/api/events/${eventId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('returns 404 for non-existent event', async () => {
      const fakeId = '507f1f77bcf86cd799439011';
      const res = await request
        .delete(`/api/events/${fakeId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Event scoping', () => {
    it('user A cannot see user B events', async () => {
      // User A creates an event
      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'User A Event', date: '2026-06-01' });

      // Create User B
      const userB = await createTestUser({ email: 'userb@yourguava.com', cafeName: 'Cafe B' });

      // User B should not see User A's events
      const res = await request
        .get('/api/events')
        .set('Authorization', `Bearer ${userB.token}`)
        .query({ from: '2026-06-01', to: '2026-06-30' });

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(0);
    });
  });
});
