const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Staff API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  describe('POST /api/staff', () => {
    it('creates a staff member', async () => {
      const res = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Alice Barista',
          email: 'alice@cafe.com',
          phone: '0821234567',
          role: 'barista',
          hourlyRate: 55,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.staff).toBeDefined();
      expect(res.body.staff.name).toBe('Alice Barista');
      expect(res.body.staff.hourlyRate).toBe(55);
    });

    it('returns 400 when name or hourlyRate is missing', async () => {
      const res = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'noname@cafe.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/staff', () => {
    it('lists active staff with leave balances', async () => {
      // Create two staff
      await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Staff A', hourlyRate: 50, role: 'barista' });

      await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Staff B', hourlyRate: 60, role: 'kitchen' });

      const res = await request
        .get('/api/staff')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.staff.length).toBe(2);
      // Each should have leaveBalance attached
      expect(res.body.staff[0].leaveBalance).toBeDefined();
    });
  });

  describe('PUT /api/staff/:id', () => {
    it('updates staff details', async () => {
      const createRes = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'To Update', hourlyRate: 50 });

      const staffId = createRes.body.staff._id;

      const res = await request
        .put(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Name', hourlyRate: 65 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.staff.name).toBe('Updated Name');
      expect(res.body.staff.hourlyRate).toBe(65);
    });
  });

  describe('Manager access', () => {
    const forbidden = { success: false, message: 'Insufficient permissions' };

    it('blocks managers from creating staff', async () => {
      const manager = await createTestManager(token, [user.activeCafeId]);

      const res = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${manager.token}`)
        .send({ name: 'Sneaky Hire', hourlyRate: 500, role: 'barista' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual(forbidden);

      const listRes = await request
        .get('/api/staff')
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.body.staff).toHaveLength(0);
    });

    it('blocks managers from updating or deactivating staff', async () => {
      const manager = await createTestManager(token, [user.activeCafeId]);
      const createRes = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Protected Staff', hourlyRate: 50 });
      const staffId = createRes.body.staff._id;

      const updateRes = await request
        .put(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({ hourlyRate: 999 });
      expect(updateRes.status).toBe(403);
      expect(updateRes.body).toEqual(forbidden);

      const deleteRes = await request
        .delete(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${manager.token}`);
      expect(deleteRes.status).toBe(403);
      expect(deleteRes.body).toEqual(forbidden);

      const ownerView = await request
        .get(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(ownerView.body.staff).toMatchObject({ hourlyRate: 50, isActive: true });
    });

    it('hides hourlyRate from managers on list and detail while owners still see it', async () => {
      const manager = await createTestManager(token, [user.activeCafeId]);
      const createRes = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Paid Staff', hourlyRate: 55, role: 'barista' });
      const staffId = createRes.body.staff._id;

      const managerList = await request
        .get('/api/staff')
        .set('Authorization', `Bearer ${manager.token}`);
      expect(managerList.status).toBe(200);
      expect(managerList.body.staff).toHaveLength(1);
      expect(managerList.body.staff[0].name).toBe('Paid Staff');
      expect(managerList.body.staff[0].leaveBalance).toBeDefined();
      expect(managerList.body.staff[0]).not.toHaveProperty('hourlyRate');

      const managerDetail = await request
        .get(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${manager.token}`);
      expect(managerDetail.status).toBe(200);
      expect(managerDetail.body.staff.name).toBe('Paid Staff');
      expect(managerDetail.body.staff).not.toHaveProperty('hourlyRate');

      const ownerList = await request
        .get('/api/staff')
        .set('Authorization', `Bearer ${token}`);
      expect(ownerList.body.staff[0].hourlyRate).toBe(55);

      const ownerDetail = await request
        .get(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(ownerDetail.body.staff.hourlyRate).toBe(55);
    });
  });

  describe('DELETE /api/staff/:id', () => {
    it('soft deletes (deactivates) staff member', async () => {
      const createRes = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'To Deactivate', hourlyRate: 50 });

      const staffId = createRes.body.staff._id;

      const res = await request
        .delete(`/api/staff/${staffId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deactivated/i);

      // Staff should not appear in active list
      const listRes = await request
        .get('/api/staff')
        .set('Authorization', `Bearer ${token}`);

      expect(listRes.body.staff.length).toBe(0);
    });
  });
});
