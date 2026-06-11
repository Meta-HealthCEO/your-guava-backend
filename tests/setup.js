const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Set env vars before requiring app
process.env.JWT_SECRET = 'test-jwt-secret-key-12345';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-12345';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.NODE_ENV = 'test';
process.env.WEATHER_API_KEY = '';
process.env.WEATHER_API_URL = '';
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;
delete process.env.RESEND_REPLY_TO;
delete process.env.PAYMENT_PROVIDER;
delete process.env.ONEGATE_API_URL;
delete process.env.ONEGATE_ORGANISATION_ID;
delete process.env.ONEGATE_ORG_ID;
delete process.env.ONEGATE_API_SALT;
delete process.env.API_PUBLIC_URL;

const app = require('../src/app');

let mongoServer;

const setup = async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
};

const teardown = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await mongoServer.stop();
};

const clearDB = async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
};

// Helper to create a test user and get auth token
const createTestUser = async (overrides = {}) => {
  const supertest = require('supertest');
  const request = supertest(app);

  const data = {
    name: 'Test Owner',
    email: overrides.email || 'test@yourguava.com',
    password: 'password123',
    cafeName: 'Test Cafe',
    orgName: 'Test Org',
    ...overrides,
  };

  const res = await request.post('/api/auth/register').send(data);

  return {
    token: res.body.accessToken,
    user: res.body.user,
    cookie: res.headers['set-cookie'],
  };
};

// Helper to create a manager via the team invite.
// The server generates the temporary password; with no email provider
// configured in tests it is returned in the invite response.
const createTestManager = async (ownerToken, cafeIds) => {
  const supertest = require('supertest');
  const request = supertest(app);

  const inviteRes = await request
    .post('/api/team/invite')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      name: 'Test Manager',
      email: 'manager@yourguava.com',
      cafeIds,
    });

  if (!inviteRes.body.temporaryPassword) {
    throw new Error(
      `createTestManager: temporaryPassword missing from invite response (emailSent=${inviteRes.body.emailSent}). ` +
        'Ensure no email provider is configured in the test environment.'
    );
  }

  // Login as manager to get token
  const loginRes = await request.post('/api/auth/login').send({
    email: 'manager@yourguava.com',
    password: inviteRes.body.temporaryPassword,
  });

  return {
    token: loginRes.body.accessToken,
    user: loginRes.body.user,
    temporaryPassword: inviteRes.body.temporaryPassword,
  };
};

module.exports = { setup, teardown, clearDB, createTestUser, createTestManager, app };
