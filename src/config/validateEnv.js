const PLACEHOLDER_VALUES = new Set([
  'your_jwt_secret_here',
  'your_jwt_refresh_secret_here',
]);

/**
 * Validates required environment variables at startup.
 * Throws on fatal misconfiguration so the server refuses to boot
 * rather than running insecurely.
 */
const validateEnv = () => {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === 'production';

  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGODB_URI']) {
    if (!process.env[name]) {
      errors.push(`${name} is required`);
    } else if (PLACEHOLDER_VALUES.has(process.env[name])) {
      errors.push(`${name} is still set to its placeholder value`);
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
    if (process.env.YOCO_CLIENT_ID && !process.env.YOCO_WEBHOOK_SECRET) {
      warnings.push(
        'YOCO_WEBHOOK_SECRET is not set — Yoco webhooks will be rejected until it is configured'
      );
    }
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
      warnings.push(
        'TOKEN_ENCRYPTION_KEY is not set — integration tokens will be encrypted with a key derived from JWT_SECRET'
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
