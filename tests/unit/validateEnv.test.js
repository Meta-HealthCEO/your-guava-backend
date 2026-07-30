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
  'ONEGATE_API_URL',
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
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'ANTHROPIC_API_KEY',
  'WEATHER_API_KEY',
  'WEATHER_API_URL',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
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
  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.R2_BUCKET_NAME = 'test-bucket';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.WEATHER_API_KEY = 'test-weather-key';
  process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_FROM_EMAIL = 'Your Guava <hello@yourguava.example>';
};

const setProductionBillingEnv = () => {
  process.env.PAYMENT_PROVIDER = 'onegate';
  process.env.ONEGATE_ORGANISATION_ID = '21234';
  process.env.ONEGATE_API_SALT = 'test-salt';
  process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
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

  it('rejects production startup when durable upload storage is incomplete', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.R2_SECRET_ACCESS_KEY;

    expect(() => validateEnv()).toThrow(/R2_SECRET_ACCESS_KEY is required/i);
  });

  it('requires an independent production token-encryption key', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.TOKEN_ENCRYPTION_KEY;

    expect(() => validateEnv()).toThrow(/TOKEN_ENCRYPTION_KEY is required/i);
  });

  it('rejects insecure public production URLs', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.CLIENT_URL = 'http://app.yourguava.example';

    expect(() => validateEnv()).toThrow(/CLIENT_URL must be a valid HTTPS URL/i);
  });

  it('rejects non-HTTPS or non-OneGate payment API origins in production', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.ONEGATE_API_URL = 'http://payments.onegate.co.za';
    expect(() => validateEnv()).toThrow(/ONEGATE_API_URL.*official OneGate/i);

    process.env.ONEGATE_API_URL = 'https://payments.attacker.example';
    expect(() => validateEnv()).toThrow(/ONEGATE_API_URL.*official OneGate/i);
  });

  it('rejects production startup when a core service is unavailable', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.RESEND_API_KEY;

    expect(() => validateEnv()).toThrow(/RESEND_API_KEY is required/i);
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
