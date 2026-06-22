const PLACEHOLDER_VALUES = new Set([
  'your_jwt_secret_here',
  'your_jwt_refresh_secret_here',
]);

const enabled = (name) => String(process.env[name] || '').toLowerCase() === 'true';

const REQUIRED_YOCO_ENV = [
  'YOCO_CLIENT_ID',
  'YOCO_CLIENT_SECRET',
  'YOCO_REDIRECT_URI',
  'YOCO_API_URL',
  'YOCO_IAM_URL',
  'YOCO_WEBHOOK_SECRET',
];

/**
 * Validates required environment variables at startup.
 * Throws on fatal misconfiguration so the server refuses to boot
 * rather than running insecurely.
 */
const validateEnv = () => {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === 'production';
  const yocoEnabled = enabled('YOCO_INTEGRATION_ENABLED');
  const accountingEnabled = enabled('ACCOUNTING_INTEGRATIONS_ENABLED');

  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGODB_URI']) {
    if (!process.env[name]) {
      errors.push(`${name} is required`);
    } else if (PLACEHOLDER_VALUES.has(process.env[name])) {
      errors.push(`${name} is still set to its placeholder value`);
    }
  }

  if (yocoEnabled) {
    for (const name of REQUIRED_YOCO_ENV) {
      if (!process.env[name]) {
        errors.push(`${name} is required when YOCO_INTEGRATION_ENABLED=true`);
      }
    }
  }

  if (isProduction) {
    if ((process.env.JWT_SECRET || '').length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters in production');
    }
    if ((process.env.JWT_REFRESH_SECRET || '').length < 32) {
      errors.push('JWT_REFRESH_SECRET must be at least 32 characters in production');
    }
    if (!process.env.CLIENT_URL) {
      errors.push('CLIENT_URL is required in production (CORS origin)');
    }
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
      warnings.push(
        'TOKEN_ENCRYPTION_KEY is not set - integration tokens will be encrypted with a key derived from JWT_SECRET'
      );
    }
    if (enabled('BILLING_MOCK_ENABLED')) {
      errors.push('BILLING_MOCK_ENABLED cannot be true in production');
    }
    if (process.env.PAYMENT_PROVIDER !== 'onegate') {
      errors.push('PAYMENT_PROVIDER must be set to "onegate" in production');
    }
    if (!process.env.ONEGATE_ORGANISATION_ID && !process.env.ONEGATE_ORG_ID) {
      errors.push('ONEGATE_ORGANISATION_ID or ONEGATE_ORG_ID is required for production billing');
    }
    if (!process.env.ONEGATE_API_SALT) {
      errors.push('ONEGATE_API_SALT is required for production billing');
    }
    if (!process.env.API_PUBLIC_URL) {
      errors.push('API_PUBLIC_URL is required in production for OneGate return and webhook callbacks');
    }
    if (yocoEnabled) {
      errors.push('YOCO_INTEGRATION_ENABLED must remain false in production for MVP');
    }
    if (accountingEnabled) {
      errors.push(
        'ACCOUNTING_INTEGRATIONS_ENABLED must remain false in production until provider posting is implemented'
      );
    }
  }

  for (const warning of warnings) {
    console.warn(`[env] WARNING: ${warning}`);
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n - ${errors.join('\n - ')}`);
  }
};

module.exports = validateEnv;
