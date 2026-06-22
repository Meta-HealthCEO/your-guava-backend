const validateEnv = require('../../src/config/validateEnv');

const KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  'CLIENT_URL',
  'PAYMENT_PROVIDER',
  'ONEGATE_ORGANISATION_ID',
  'ONEGATE_ORG_ID',
  'ONEGATE_API_SALT',
  'API_PUBLIC_URL',
  'BILLING_MOCK_ENABLED',
  'TOKEN_ENCRYPTION_KEY',
  'YOCO_INTEGRATION_ENABLED',
  'YOCO_CLIENT_ID',
  'YOCO_CLIENT_SECRET',
  'YOCO_REDIRECT_URI',
  'YOCO_API_URL',
  'YOCO_IAM_URL',
  'YOCO_WEBHOOK_SECRET',
  'ACCOUNTING_INTEGRATIONS_ENABLED',
];

const snapshotEnv = () =>
  KEYS.reduce((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {});

const restoreEnv = (snapshot) => {
  for (const key of KEYS) {
    if (snapshot[key] == null) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
};

const setProductionBaseEnv = () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'x'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'y'.repeat(32);
  process.env.MONGODB_URI = 'mongodb://localhost:27017/guava-test';
  process.env.CLIENT_URL = 'https://app.yourguava.example';
  process.env.TOKEN_ENCRYPTION_KEY = 'z'.repeat(32);
};

const setProductionBillingEnv = () => {
  process.env.PAYMENT_PROVIDER = 'onegate';
  process.env.ONEGATE_ORGANISATION_ID = '21234';
  process.env.ONEGATE_API_SALT = 'test-salt';
  process.env.API_PUBLIC_URL = 'https://api.yourguava.example';
};

describe('validateEnv', () => {
  let env;

  beforeEach(() => {
    env = snapshotEnv();
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv(env);
    jest.restoreAllMocks();
  });

  it('rejects production startup without a real billing provider by default', () => {
    setProductionBaseEnv();

    expect(() => validateEnv()).toThrow(/PAYMENT_PROVIDER.*onegate/i);
  });

  it('allows production startup with OneGate billing configured', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects production mock billing even when explicitly enabled', () => {
    setProductionBaseEnv();
    process.env.BILLING_MOCK_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/BILLING_MOCK_ENABLED cannot be true/i);
  });

  it('does not warn about Yoco webhook secrets while the legacy Yoco integration is disabled', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('requires full legacy Yoco config when Yoco is explicitly enabled outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev-secret';
    process.env.JWT_REFRESH_SECRET = 'dev-refresh-secret';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/guava-dev';
    process.env.YOCO_INTEGRATION_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/YOCO_CLIENT_ID.*YOCO_WEBHOOK_SECRET/s);
  });

  it('rejects production startup when the legacy Yoco integration is enabled', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.YOCO_INTEGRATION_ENABLED = 'true';
    process.env.YOCO_CLIENT_ID = 'yoco-client';
    process.env.YOCO_CLIENT_SECRET = 'yoco-secret';
    process.env.YOCO_REDIRECT_URI = 'https://app.yourguava.example/connect';
    process.env.YOCO_API_URL = 'https://api.yoco.example';
    process.env.YOCO_IAM_URL = 'https://iam.yoco.example';
    process.env.YOCO_WEBHOOK_SECRET = 'whsec_test';

    expect(() => validateEnv()).toThrow(/YOCO_INTEGRATION_ENABLED must remain false in production/i);
  });

  it('rejects production startup when accounting integrations are enabled before posting is implemented', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/ACCOUNTING_INTEGRATIONS_ENABLED must remain false in production/i);
  });
});
