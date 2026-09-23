const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

// The test environment is set in tests/env.js (Jest setupFiles), before any module loads.
// Do not set env here: by the time a test requires this file, other modules may already have read it.
// Outbound network is refused by tests/hermetic.js (Jest setupFilesAfterEnv), which patches http/https request and get and
// global fetch for every test file, including the unit files that never load this helper. Refuse to run without it.
if (!globalThis.__guavaNetworkGuard) {
  throw new Error('tests/hermetic.js did not run: jest.config.js must list it in setupFilesAfterEnv (BE-12-T01)');
}

const app = require('../src/app');

let mongoServer;

const setup = async () => {
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
};

// A key taken from tenant data and written through a plain object can land on
// Object.prototype (an item named "__proto__") or on the Object constructor
// (an item named "constructor") for the whole process (security-2). Every
// suite that uses this setup proves on the way out that nothing did.
const assertPrototypesClean = () => {
  const leaks = [
    ['Object.prototype', Object.keys(Object.prototype)],
    ['Object', Object.keys(Object)],
    ['Function.prototype', Object.keys(Function.prototype)],
    ['Array.prototype', Object.keys(Array.prototype)],
  ].filter(([, keys]) => keys.length > 0);
  if (leaks.length > 0) {
    throw new Error(`Prototype pollution: ${leaks.map(([where, keys]) => `${where}.${keys.join(',')}`).join('; ')}`);
  }
};

const teardown = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await mongoServer.stop();
  // Last, after every resource is closed, so a leak fails the suite without leaving a server running.
  assertPrototypesClean();
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
  const emailService = require('../src/services/email.service');
  const request = supertest(app);

  const data = {
    name: 'Test Owner',
    email: overrides.email || 'test@yourguava.com',
    password: 'password123',
    cafeName: 'Test Cafe',
    orgName: 'Test Org',
    ...overrides,
  };

  let verificationToken;
  const verificationSpy = jest
    .spyOn(emailService, 'sendVerificationEmail')
    .mockImplementation(async ({ verificationToken: token }) => {
      verificationToken = token;
      return { sent: true };
    });

  try {
    const registration = await request.post('/api/auth/register').send(data);
    if (registration.status !== 202 || !verificationToken) {
      throw new Error(
        `Test registration failed (${registration.status}): ${JSON.stringify(registration.body)}`
      );
    }

    const verification = await request
      .post('/api/auth/verify-email')
      .send({ token: verificationToken, password: data.password });
    if (verification.status !== 201) {
      throw new Error(
        `Test email verification failed (${verification.status}): ${JSON.stringify(verification.body)}`
      );
    }

    const login = await request.post('/api/auth/login').send({
      email: data.email,
      password: data.password,
    });
    if (login.status !== 200) {
      throw new Error(`Test login failed (${login.status}): ${JSON.stringify(login.body)}`);
    }

    return {
      token: login.body.accessToken,
      user: login.body.user,
      cookie: login.headers['set-cookie'],
    };
  } finally {
    verificationSpy.mockRestore();
  }
};

// Helper to create a manager directly when a test is not exercising the
// production invitation-acceptance lifecycle.
const createTestManager = async (ownerToken, cafeIds) => {
  const supertest = require('supertest');
  const request = supertest(app);
  const User = require('../src/models/User.model');

  const decoded = jwt.verify(ownerToken, process.env.JWT_SECRET);
  const owner = await User.findById(decoded.id).lean();
  const password = 'password123';
  const email = 'manager@yourguava.com';

  await User.create({
    name: 'Test Manager',
    email,
    password,
    role: 'manager',
    orgId: owner.orgId,
    cafeIds,
    activeCafeId: cafeIds[0],
  });

  // Login as manager to get token
  const loginRes = await request.post('/api/auth/login').send({
    email,
    password,
  });

  return {
    token: loginRes.body.accessToken,
    user: loginRes.body.user,
    password,
  };
};

module.exports = { setup, teardown, clearDB, createTestUser, createTestManager, app, assertPrototypesClean };
