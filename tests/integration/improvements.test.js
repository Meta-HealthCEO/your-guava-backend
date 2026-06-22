const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Improvement = require('../../src/models/Improvement.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const validBody = (overrides = {}) => ({
  type: 'fix',
  title: 'Forecast chart cuts off on mobile',
  area: 'planning',
  priority: 'high',
  description: 'On a narrow screen the weekly forecast chart overflows its card.',
  desiredOutcome: 'Chart fits within the card at 320px width.',
  ...overrides,
});

describe('Improvements API', () => {
  let ownerToken;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
  });

  describe('POST /api/improvements', () => {
    it('creates a ticket with sequential numbers starting at 1', async () => {
      const first = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());

      expect(first.status).toBe(201);
      expect(first.body.success).toBe(true);
      expect(first.body.improvement.ticketNumber).toBe(1);
      expect(first.body.improvement.status).toBe('open');
      expect(first.body.improvement.type).toBe('fix');
      // Reporter is denormalized for self-explanatory tickets
      expect(first.body.improvement.createdBy.email).toBe('test@yourguava.com');
      expect(first.body.improvement.createdBy.name).toBe('Test Owner');

      const second = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ title: 'Second ticket' }));

      expect(second.body.improvement.ticketNumber).toBe(2);
    });

    it('defaults type/area/priority/status sensibly', async () => {
      const res = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'Just a title', description: 'Just a description' });

      expect(res.status).toBe(201);
      expect(res.body.improvement.type).toBe('improvement');
      expect(res.body.improvement.area).toBe('other');
      expect(res.body.improvement.priority).toBe('medium');
      expect(res.body.improvement.status).toBe('open');
    });

    it('rejects missing title or description', async () => {
      const noTitle = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ description: 'desc only' });
      expect(noTitle.status).toBe(400);

      const noDesc = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'title only' });
      expect(noDesc.status).toBe(400);
    });

    it('rejects invalid enum values', async () => {
      const res = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ type: 'nonsense' }));
      expect(res.status).toBe(400);
    });

    it('rejects invalid page context values', async () => {
      const nonText = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ pageUrl: { path: '/today' } }));
      expect(nonText.status).toBe(400);
      expect(nonText.body.message).toMatch(/pageUrl must be text/i);

      const tooLong = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ pageUrl: `/${'x'.repeat(301)}` }));
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toMatch(/300 characters/i);
    });

    it('allows a manager (partner) to log a ticket', async () => {
      const owner = await createTestUser({ email: 'owner-mgr@yourguava.com' });
      const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

      const res = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${manager.token}`)
        .send(validBody({ title: 'Logged by a manager' }));

      expect(res.status).toBe(201);
      expect(res.body.improvement.createdBy.email).toBe('manager@yourguava.com');
    });
  });

  describe('GET /api/improvements', () => {
    it('lists the org tickets with status counts, scoped to the org', async () => {
      await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ title: 'Mine A' }));
      await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ title: 'Mine B' }));

      // A different org's ticket must not be visible
      const otherOwner = await createTestUser({ email: 'other@yourguava.com' });
      await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${otherOwner.token}`)
        .send(validBody({ title: 'Not mine' }));

      const res = await request
        .get('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.improvements).toHaveLength(2);
      expect(res.body.improvements.map((i) => i.title)).toEqual(
        expect.arrayContaining(['Mine A', 'Mine B'])
      );
      expect(res.body.counts.all).toBe(2);
      expect(res.body.counts.open).toBe(2);
      // Newest ticket first
      expect(res.body.improvements[0].ticketNumber).toBeGreaterThan(
        res.body.improvements[1].ticketNumber
      );
    });

    it('filters by status', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ title: 'To be done' }));
      await request
        .patch(`/api/improvements/${created.body.improvement._id}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'done' });

      const open = await request
        .get('/api/improvements?status=open')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(open.body.improvements).toHaveLength(0);

      const done = await request
        .get('/api/improvements?status=done')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(done.body.improvements).toHaveLength(1);
      // Counts always reflect the whole board regardless of the filter
      expect(done.body.counts.all).toBe(1);
      expect(done.body.counts.done).toBe(1);
    });

    it('filters by type', async () => {
      await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ type: 'fix', title: 'A fix' }));
      await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ type: 'improvement', title: 'An idea' }));

      const fixes = await request
        .get('/api/improvements?type=fix')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(fixes.body.improvements).toHaveLength(1);
      expect(fixes.body.improvements[0].type).toBe('fix');
      // counts remain whole-board
      expect(fixes.body.counts.all).toBe(2);
    });

    it('rejects invalid filters instead of silently ignoring them', async () => {
      const res = await request
        .get('/api/improvements?status=banana')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/status must be one of/i);
    });

    it('paginates with total/pages and stable newest-first ordering', async () => {
      for (let i = 0; i < 3; i++) {
        await request
          .post('/api/improvements')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send(validBody({ title: `Ticket ${i}` }));
      }

      const page1 = await request
        .get('/api/improvements?page=1&limit=2')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(page1.body.improvements).toHaveLength(2);
      expect(page1.body.pagination).toEqual(
        expect.objectContaining({ total: 3, page: 1, limit: 2, pages: 2 })
      );

      const page2 = await request
        .get('/api/improvements?page=2&limit=2')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(page2.body.improvements).toHaveLength(1);
      // No overlap between pages
      const ids1 = page1.body.improvements.map((i) => i._id);
      expect(ids1).not.toContain(page2.body.improvements[0]._id);
    });
  });

  describe('GET /api/improvements/:id', () => {
    it('returns a ticket for its org and 404 across orgs / for bad ids', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());
      const id = created.body.improvement._id;

      const found = await request
        .get(`/api/improvements/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(found.status).toBe(200);
      expect(found.body.improvement._id).toBe(id);

      const otherOwner = await createTestUser({ email: 'getone-other@yourguava.com' });
      const crossOrg = await request
        .get(`/api/improvements/${id}`)
        .set('Authorization', `Bearer ${otherOwner.token}`);
      expect(crossOrg.status).toBe(404);

      const badId = await request
        .get('/api/improvements/not-a-valid-objectid')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(badId.status).toBe(404);
    });
  });

  describe('input validation', () => {
    it('rejects an over-length title with 400 (not 500)', async () => {
      const res = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody({ title: 'x'.repeat(200) }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/140 characters/i);
    });

    it('rejects a non-string title with 400', async () => {
      const res = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: ['a', 'b'], description: 'valid' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/improvements/:id/status', () => {
    it('owner can change status; manager cannot', async () => {
      const owner = await createTestUser({ email: 'owner4@yourguava.com' });
      const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${manager.token}`)
        .send(validBody({ title: 'Triage me' }));
      const id = created.body.improvement._id;

      const managerAttempt = await request
        .patch(`/api/improvements/${id}/status`)
        .set('Authorization', `Bearer ${manager.token}`)
        .send({ status: 'in_progress' });
      expect(managerAttempt.status).toBe(403);

      const ownerAttempt = await request
        .patch(`/api/improvements/${id}/status`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ status: 'in_progress', resolutionNotes: 'Picked up' });
      expect(ownerAttempt.status).toBe(200);
      expect(ownerAttempt.body.improvement.status).toBe('in_progress');
      expect(ownerAttempt.body.improvement.resolutionNotes).toBe('Picked up');
    });

    it('rejects an invalid status value', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());
      const res = await request
        .patch(`/api/improvements/${created.body.improvement._id}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'banana' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid resolution notes', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());

      const nonText = await request
        .patch(`/api/improvements/${created.body.improvement._id}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'done', resolutionNotes: { note: 'fixed' } });
      expect(nonText.status).toBe(400);
      expect(nonText.body.message).toMatch(/resolutionNotes must be text/i);

      const tooLong = await request
        .patch(`/api/improvements/${created.body.improvement._id}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'done', resolutionNotes: 'x'.repeat(2001) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toMatch(/2000 characters/i);
    });

    it('returns 404 for another org ticket', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());
      const otherOwner = await createTestUser({ email: 'other2@yourguava.com' });
      const res = await request
        .patch(`/api/improvements/${created.body.improvement._id}/status`)
        .set('Authorization', `Bearer ${otherOwner.token}`)
        .send({ status: 'done' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/improvements/:id', () => {
    it('owner can delete; manager cannot', async () => {
      const owner = await createTestUser({ email: 'owner5@yourguava.com' });
      const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${owner.token}`)
        .send(validBody());
      const id = created.body.improvement._id;

      const managerAttempt = await request
        .delete(`/api/improvements/${id}`)
        .set('Authorization', `Bearer ${manager.token}`);
      expect(managerAttempt.status).toBe(403);

      const ownerAttempt = await request
        .delete(`/api/improvements/${id}`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(ownerAttempt.status).toBe(200);

      const remaining = await Improvement.countDocuments({});
      expect(remaining).toBe(0);
    });

    it('returns 404 when deleting another org ticket', async () => {
      const created = await request
        .post('/api/improvements')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validBody());
      const otherOwner = await createTestUser({ email: 'other-del@yourguava.com' });

      const res = await request
        .delete(`/api/improvements/${created.body.improvement._id}`)
        .set('Authorization', `Bearer ${otherOwner.token}`);
      expect(res.status).toBe(404);

      // The ticket must still exist for its real org
      const remaining = await Improvement.countDocuments({});
      expect(remaining).toBe(1);
    });
  });

  describe('auth', () => {
    it('requires authentication', async () => {
      const res = await request.get('/api/improvements');
      expect(res.status).toBe(401);
    });
  });
});
