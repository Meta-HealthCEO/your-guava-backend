const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const emailService = require('../../src/services/email.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('Team API', () => {
  let ownerToken;
  let ownerUser;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;
  });

  describe('POST /api/team/invite', () => {
    it('stores only a hashed pending token, then accepts it exactly once', async () => {
      const cafeId = ownerUser.activeCafeId;
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'New Manager',
          email: 'manager@yourguava.com',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.email).toBe('manager@yourguava.com');
      expect(res.body.emailSent).toBe(true);
      expect(res.body.token).toBeUndefined();
      expect(inviteSpy).toHaveBeenCalledTimes(1);
      expect(inviteSpy).toHaveBeenCalledWith({
        invitation: expect.objectContaining({
          email: 'manager@yourguava.com',
          name: 'New Manager',
        }),
        owner: expect.objectContaining({ email: 'test@yourguava.com' }),
        cafes: expect.arrayContaining([expect.objectContaining({ name: 'Test Cafe' })]),
        invitationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });

      expect(await User.findOne({ email: 'manager@yourguava.com' })).toBeNull();
      const invitationToken = inviteSpy.mock.calls[0][0].invitationToken;
      const persistedInvite = await TeamInvitation.findById(res.body.invitation.id).select('+tokenHash');
      expect(persistedInvite.status).toBe('pending');
      expect(persistedInvite.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persistedInvite.tokenHash).not.toBe(invitationToken);
      expect(JSON.stringify(res.body)).not.toContain(invitationToken);

      const preview = await request
        .post('/api/team/invitations/preview')
        .send({ token: invitationToken });
      expect(preview.status).toBe(200);
      expect(preview.headers['cache-control']).toBe('no-store');
      expect(preview.body.invitation).toEqual(expect.objectContaining({
        email: 'manager@yourguava.com',
        organizationName: 'Test Org',
        cafeNames: ['Test Cafe'],
      }));
      expect(JSON.stringify(preview.body)).not.toContain(invitationToken);

      const accepted = await request
        .post('/api/team/invitations/accept')
        .send({ token: invitationToken, password: 'chosen-password-123' });
      expect(accepted.status).toBe(201);
      expect(accepted.headers['cache-control']).toBe('no-store');
      expect(accepted.body.user).toEqual({ email: 'manager@yourguava.com' });

      const persisted = await User.findOne({ email: 'manager@yourguava.com' }).select('+password');
      expect(persisted).toBeTruthy();
      expect(persisted.role).toBe('manager');
      expect(persisted.orgId.toString()).toBe(ownerUser.orgId.toString());
      expect(persisted.activeCafeId.toString()).toBe(cafeId.toString());
      await expect(persisted.comparePassword('chosen-password-123')).resolves.toBe(true);

      const replay = await request
        .post('/api/team/invitations/accept')
        .send({ token: invitationToken, password: 'another-password-123' });
      expect(replay.status).toBe(404);
      expect(replay.headers['cache-control']).toBe('no-store');
      expect(replay.body.message).toMatch(/invalid or has expired/i);
      expect(await User.countDocuments({ email: 'manager@yourguava.com' })).toBe(1);
    });

    it('revokes the pending token and creates no account when invite email is skipped', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ skipped: true, reason: 'resend_not_configured' });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'No Email Manager',
          email: 'no-email@yourguava.com',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.emailSent).toBe(false);
      expect(res.body.message).toMatch(/email is not configured/i);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/invitation .* blocked because email is not configured/i));

      const persisted = await User.findOne({ email: 'no-email@yourguava.com' });
      expect(persisted).toBeNull();
      const invitation = await TeamInvitation.findOne({ email: 'no-email@yourguava.com' });
      expect(invitation.status).toBe('revoked');
      expect(res.body.seats.used).toBe(1);
    });

    it('manager cannot invite (403)', async () => {
      const cafeId = ownerUser.activeCafeId;

      // Create manager first
      const manager = await createTestManager(ownerToken, [cafeId]);

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${manager.token}`)
        .send({
          name: 'Another Manager',
          email: 'another@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('blocks invites when plan seat limit is reached', async () => {
      const cafeId = ownerUser.activeCafeId;

      await createTestManager(ownerToken, [cafeId]);

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Extra Manager',
          email: 'extra@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(402);
      expect(res.body.message).toMatch(/seat limit/i);
    });

    it('serializes concurrent invites so the seat limit cannot be exceeded', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      const responses = await Promise.all([
        request
          .post('/api/team/invite')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'Manager A', email: 'manager-a@yourguava.com', cafeIds: [cafeId] }),
        request
          .post('/api/team/invite')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'Manager B', email: 'manager-b@yourguava.com', cafeIds: [cafeId] }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 402]);
      expect(await User.countDocuments({ orgId: ownerUser.orgId })).toBe(1);
      expect(await TeamInvitation.countDocuments({ orgId: ownerUser.orgId, status: 'pending' })).toBe(1);
    });

    it('serializes concurrent acceptance and creates one manager account', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Concurrent Manager',
          email: 'concurrent@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const token = inviteSpy.mock.calls[0][0].invitationToken;

      const responses = await Promise.all([
        request.post('/api/team/invitations/accept').send({ token, password: 'chosen-password-123' }),
        request.post('/api/team/invitations/accept').send({ token, password: 'chosen-password-123' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 404]);
      expect(await User.countDocuments({ email: 'concurrent@yourguava.com' })).toBe(1);
    });

    it('revalidates the seat limit at acceptance time', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Delayed Manager',
          email: 'delayed@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const token = inviteSpy.mock.calls[0][0].invitationToken;
      await User.create({
        name: 'Existing Manager',
        email: 'existing@yourguava.com',
        password: 'password123',
        role: 'manager',
        orgId: ownerUser.orgId,
        cafeIds: [ownerUser.activeCafeId],
        activeCafeId: ownerUser.activeCafeId,
      });

      const accepted = await request
        .post('/api/team/invitations/accept')
        .send({ token, password: 'chosen-password-123' });

      expect(accepted.status).toBe(409);
      expect(accepted.body.message).toMatch(/ask the account owner/i);
      expect(await User.findOne({ email: 'delayed@yourguava.com' })).toBeNull();
      expect((await TeamInvitation.findOne({ email: 'delayed@yourguava.com' })).status).toBe('pending');
    });

    it('rotates tokens on resend and revokes an unused invitation', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      const invited = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Resend Manager',
          email: 'resend@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const firstToken = inviteSpy.mock.calls[0][0].invitationToken;

      const resent = await request
        .post(`/api/team/invitations/${invited.body.invitation.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(resent.status).toBe(200);
      const secondToken = inviteSpy.mock.calls[1][0].invitationToken;
      expect(secondToken).not.toBe(firstToken);

      expect((await request.post('/api/team/invitations/preview').send({ token: firstToken })).status).toBe(404);
      expect((await request.post('/api/team/invitations/preview').send({ token: secondToken })).status).toBe(200);

      const revoked = await request
        .delete(`/api/team/invitations/${invited.body.invitation.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.seats).toEqual(expect.objectContaining({ active: 1, pending: 0, used: 1 }));
      expect((await request.post('/api/team/invitations/preview').send({ token: secondToken })).status).toBe(404);
    });
  });

  describe('GET /api/team', () => {
    it('lists active members separately from pending invitations', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      // Send an invitation without accepting it.
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Team Member',
          email: 'team@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      const res = await request
        .get('/api/team')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.members).toBeDefined();
      expect(res.body.members).toHaveLength(1);
      expect(res.body.invitations).toHaveLength(1);
      expect(res.body.invitations[0].email).toBe('team@yourguava.com');
      expect(res.body.seats).toEqual(expect.objectContaining({ active: 1, pending: 1, used: 2 }));
    });
  });

  describe('POST /api/team/switch-cafe', () => {
    it('switches active cafe and returns new token', async () => {
      // Add a second cafe
      const addRes = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Second Cafe' });

      const secondCafeId = addRes.body.cafe._id;

      const res = await request
        .post('/api/team/switch-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ cafeId: secondCafeId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.activeCafeId).toBe(secondCafeId);
    });
  });

  describe('POST /api/team/add-cafe', () => {
    it('adds new cafe to org', async () => {
      const res = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'New Branch' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe).toBeDefined();
      expect(res.body.cafe.name).toBe('New Branch');
    });
  });

  describe('DELETE /api/team/:id', () => {
    it('removes manager from org', async () => {
      const cafeId = ownerUser.activeCafeId;
      const manager = await createTestManager(ownerToken, [cafeId]);
      const managerId = manager.user.id;

      const res = await request
        .delete(`/api/team/${managerId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/removed/i);
    });
  });
});
