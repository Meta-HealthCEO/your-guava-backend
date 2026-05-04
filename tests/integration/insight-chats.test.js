const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Insight Chats API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
  });

  it('creates, lists, renames, archives, and deletes chats', async () => {
    const createRes = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({
        messages: [{ role: 'user', content: 'What is my top item?' }],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.chat.title).toBe('What is my top item?');
    const chatId = createRes.body.chat._id;

    const listRes = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.chats).toHaveLength(1);

    const renameRes = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Top items analysis' });

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.chat.title).toBe('Top items analysis');

    const archiveRes = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ archived: true });

    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.chat.archived).toBe(true);

    const visibleRes = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`);

    expect(visibleRes.body.chats).toHaveLength(0);

    const archivedRes = await request
      .get('/api/insight-chats')
      .query({ archived: 'true' })
      .set('Authorization', `Bearer ${token}`);

    expect(archivedRes.body.chats).toHaveLength(1);

    const deleteRes = await request
      .delete(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(200);
  });

  it('scopes chats to the authenticated user and active cafe', async () => {
    await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Private chat' });

    const userB = await createTestUser({ email: 'other@yourguava.com', cafeName: 'Other Cafe' });
    const res = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${userB.token}`);

    expect(res.status).toBe(200);
    expect(res.body.chats).toHaveLength(0);
  });
});
