const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Improvement = require('../../src/models/Improvement.model');
const { migrateImprovementTicketIndexes } = require('../../src/migrations/improvement-tickets-per-org');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const ticket = (orgId, ticketNumber) => ({ orgId, ticketNumber, type: 'fix', title: 'T', description: 'D' });

describe('improvement ticket index migration', () => {
  it('drops the legacy global unique index so two orgs can both have ticket #1', async () => {
    await Improvement.init();
    await Improvement.collection.createIndex({ ticketNumber: 1 }, { unique: true, name: 'ticketNumber_1' });
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    await Improvement.collection.insertOne(ticket(orgA, 1));
    await expect(Improvement.collection.insertOne(ticket(orgB, 1))).rejects.toMatchObject({ code: 11000 });

    const dryRun = await migrateImprovementTicketIndexes({ apply: false });
    expect(dryRun).toEqual({ dropLegacyIndex: true, applied: false });
    await migrateImprovementTicketIndexes({ apply: true });

    const names = (await Improvement.collection.indexes()).map((index) => index.name);
    expect(names).not.toContain('ticketNumber_1');
    expect(names).toContain('orgId_1_ticketNumber_1');
    await expect(Improvement.collection.insertOne(ticket(orgB, 1))).resolves.toBeTruthy();
    await expect(Improvement.collection.insertOne(ticket(orgA, 1))).rejects.toMatchObject({ code: 11000 });
  });
});
