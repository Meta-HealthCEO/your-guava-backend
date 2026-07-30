const { EventEmitter } = require('events');

const mockListen = jest.fn();
const mockConnectDB = jest.fn();
const mockValidateEnv = jest.fn();
const mockPaymentInit = jest.fn();
const mockTeamInvitationInit = jest.fn();
const mockUsageInit = jest.fn();
const mockDisconnect = jest.fn();
const mockMongoose = { connection: { readyState: 1 }, disconnect: mockDisconnect };

jest.mock('mongoose', () => mockMongoose);
jest.mock('../../src/app', () => ({ listen: (...args) => mockListen(...args) }));
jest.mock('../../src/config/db', () => (...args) => mockConnectDB(...args));
jest.mock('../../src/config/validateEnv', () => (...args) => mockValidateEnv(...args));
jest.mock('../../src/controllers/uploads.controller', () => ({
  cleanupAbandonedPendingUploads: jest.fn(),
}));
jest.mock('../../src/models/PaymentSession.model', () => ({ init: mockPaymentInit }));
jest.mock('../../src/models/TeamInvitation.model', () => ({ init: mockTeamInvitationInit }));
jest.mock('../../src/models/UsageLedger.model', () => ({ init: mockUsageInit }));
jest.mock('../../src/services/billingPayments.service', () => ({
  reconcilePendingOneGatePayments: jest.fn(),
}));
jest.mock('../../src/services/usage.service', () => ({
  reconcileStaleUsageReservations: jest.fn(),
}));

describe('server startup cleanup', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockPaymentInit.mockResolvedValue(undefined);
    mockTeamInvitationInit.mockResolvedValue(undefined);
    mockUsageInit.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockMongoose.connection.readyState = 1;
  });

  it('disconnects Mongo when a critical index fails before listen', async () => {
    mockPaymentInit.mockRejectedValue(new Error('index failed'));
    const { start } = require('../../src/server');

    await expect(start()).rejects.toThrow('index failed');
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockListen).not.toHaveBeenCalled();
  });

  it('disconnects Mongo and clears startup state when listen fails', async () => {
    const failedServer = new EventEmitter();
    failedServer.listening = false;
    mockListen.mockImplementationOnce(() => {
      queueMicrotask(() => failedServer.emit('error', new Error('port busy')));
      return failedServer;
    });
    const { start } = require('../../src/server');

    await expect(start()).rejects.toThrow('port busy');
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
  });
});
