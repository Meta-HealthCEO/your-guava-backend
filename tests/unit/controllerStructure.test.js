const fs = require('fs');
const path = require('path');

// BE-11-T03: the uploads and team controllers became barrels over focused modules.
const SRC = path.resolve(__dirname, '../../src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const lineCount = (relative) => (read(relative).match(/\n/g) || []).length;
const UPLOADS = ['shared', 'lease', 'jobs', 'sweeper', 'list', 'detail', 'confirm', 'remap', 'remove', 'download'];
const TEAM = ['audit', 'members', 'invitations', 'ownership', 'cafes'];

describe('uploads and team controller structure (BE-11-T03)', () => {
  it.each(['controllers/uploads.controller.js', 'controllers/team.controller.js'])(
    'keeps %s a barrel: under 60 lines and no function of its own',
    (barrel) => {
      expect(lineCount(barrel)).toBeLessThan(60);
      expect(read(barrel)).not.toMatch(/=>|function\s/);
    }
  );

  it('has a module per concern', () => {
    const missing = [
      ...UPLOADS.map((name) => `controllers/uploads/${name}.js`),
      ...TEAM.map((name) => `controllers/team/${name}.js`),
    ].filter((file) => !fs.existsSync(path.join(SRC, file)));
    expect(missing).toEqual([]);
  });

  it('keeps the lease, the job queue and the sweeper out of the HTTP handlers', () => {
    const uploads = require('../../src/controllers/uploads.controller');
    expect(uploads.recoverPendingUploadMaintenance).toBe(
      require('../../src/controllers/uploads/jobs').recoverPendingUploadMaintenance
    );
    expect(uploads.cleanupAbandonedPendingUploads).toBe(
      require('../../src/controllers/uploads/sweeper').cleanupAbandonedPendingUploads
    );
    expect(typeof require('../../src/controllers/uploads/lease').commitParsedUpload).toBe('function');
    const team = require('../../src/controllers/team.controller');
    expect(team.inviteManager).toBe(require('../../src/controllers/team/invitations').inviteManager);
    expect(team.updateMember).toBe(require('../../src/controllers/team/members').updateMember);
    expect(team.transferOwnership).toBe(require('../../src/controllers/team/ownership').transferOwnership);
    expect(team.switchCafe).toBe(require('../../src/controllers/team/cafes').switchCafe);
  });
});
