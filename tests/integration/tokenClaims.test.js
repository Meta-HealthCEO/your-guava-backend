const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

it('mints the same claim set when switching cafe as at login (BE-11-T05)', async () => {
  const { token, user } = await createTestUser();
  const cafeId = String(user.activeCafeId || user.cafeIds[0]);
  const res = await request.post('/api/team/switch-cafe').set('Authorization', `Bearer ${token}`).send({ cafeId });
  expect(res.status).toBe(200);
  const claims = ({ iat, exp, ...rest }) => rest;
  expect(claims(jwt.decode(res.body.accessToken))).toEqual(claims(jwt.decode(token)));
});
