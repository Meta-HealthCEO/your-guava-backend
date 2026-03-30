const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Shifts API', () => {
  let token;
  let staffId;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;

    // Create a staff member for shift tests
    const staffRes = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Shift Worker', hourlyRate: 55, role: 'barista' });

    staffId = staffRes.body.staff._id;
  });

  describe('POST /api/shifts', () => {
    it('creates a shift', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06', // a Monday
          startTime: '07:00',
          endTime: '15:00',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.shift).toBeDefined();
      expect(res.body.shift.hoursWorked).toBe(8);
      expect(res.body.shift.type).toBe('regular');
    });

    it('returns 400 when required fields missing', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId, date: '2026-04-06' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when endTime is before startTime', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06',
          startTime: '15:00',
          endTime: '07:00',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/endTime must be after startTime/i);
    });

    it('flags overtime when exceeding 45 weekly hours', async () => {
      // Create shifts for Mon-Fri, 10 hrs each (= 50 hrs)
      const dates = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'];
      let lastRes;
      for (const date of dates) {
        lastRes = await request
          .post('/api/shifts')
          .set('Authorization', `Bearer ${token}`)
          .send({
            staffId,
            date,
            startTime: '06:00',
            endTime: '16:00',
          });
      }

      // The 5th shift (total 50 hrs) should be flagged overtime
      expect(lastRes.body.shift.type).toBe('overtime');
    });
  });

  describe('GET /api/shifts', () => {
    it('lists shifts for a date range', async () => {
      await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06',
          startTime: '07:00',
          endTime: '15:00',
        });

      const res = await request
        .get('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-04-01', endDate: '2026-04-30' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.shifts).toBeDefined();
      expect(res.body.shifts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/shifts/week', () => {
    it('returns current week roster grouped by day', async () => {
      const res = await request
        .get('/api/shifts/week')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.roster).toBeDefined();
      expect(res.body.roster.length).toBe(7); // Mon-Sun
    });
  });

  describe('GET /api/shifts/summary', () => {
    it('returns hours summary per staff member', async () => {
      // Create shifts
      await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06',
          startTime: '07:00',
          endTime: '15:00',
        });

      const res = await request
        .get('/api/shifts/summary')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-04-06', endDate: '2026-04-12' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(Array.isArray(res.body.summary)).toBe(true);

      if (res.body.summary.length > 0) {
        const entry = res.body.summary[0];
        expect(entry.totalHours).toBeDefined();
        expect(entry.estimatedPay).toBeDefined();
        expect(entry.overThreshold).toBeDefined();
      }
    });
  });
});
