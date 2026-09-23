process.env.WORKFORCE_ENABLED = '';
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

it('does not mount the workforce routes when WORKFORCE_ENABLED is off, even under test', async () => {
  const owner = await createTestUser();
  for (const route of ['/api/staff', '/api/shifts', '/api/leave']) {
    const res = await request.get(route).set('Authorization', `Bearer ${owner.token}`);
    expect({ route, status: res.status }).toEqual({ route, status: 404 });
  }
});
