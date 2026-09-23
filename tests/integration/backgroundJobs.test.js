process.env.BACKGROUND_JOBS_INLINE = 'false';
const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const { waitFor } = require('../helpers/waitFor');

const request = supertest(app);
const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

it('completes post-import maintenance after the confirm response when jobs are deferred, as in production', async () => {
  const owner = await createTestUser();
  const auth = { Authorization: `Bearer ${owner.token}` };
  const stage = await request.post('/api/transactions/upload').set(auth).attach('file', yocoFixture);
  expect(stage.status).toBe(200);

  const confirm = await request
    .post(`/api/uploads/${stage.body.uploadId}/confirm`)
    .set(auth)
    .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
  expect(confirm.status).toBe(200);

  const done = await waitFor(async () => {
    const upload = await Upload.findById(stage.body.uploadId).lean();
    return ['completed', 'partial_failure'].includes(upload?.maintenance?.status) ? upload : null;
  }, { timeoutMs: 15000, intervalMs: 25, message: 'post-import maintenance to finish' });
  expect(done.maintenance.status).toBe('completed');
});
