/**
 * Named behaviour switches (BE-12-T01). Each replaces a branch that used to key on the test NODE_ENV, so the
 * test suite runs production code with one named switch flipped, and a test can flip it back to exercise the
 * production behaviour. Unset means the production behaviour. tests/env.js sets the test values;
 * validateEnv refuses the values that would weaken a hosted deploy (rate limits off, jobs inline, origin checks off).
 * Never write the literal comparison in a comment here: tests/unit/testEnvironment.test.js and BE-12-T04's
 * nodeEnvTestBranches scan the raw source of src, comments included.
 */
const isTrue = (value) => String(value || '').trim().toLowerCase() === 'true';
const isFalse = (value) => String(value || '').trim().toLowerCase() === 'false';

const workforceEnabled = () => isTrue(process.env.WORKFORCE_ENABLED); // D-003: off unless 'true'
const apiCacheEnabled = () => !isFalse(process.env.API_CACHE_ENABLED); // on unless 'false'
const rateLimitsEnabled = () => !isFalse(process.env.RATE_LIMITS_ENABLED); // on unless 'false'
const requestLogsEnabled = () => !isFalse(process.env.REQUEST_LOGS_ENABLED); // on unless 'false'
const backgroundJobsInline = () => isTrue(process.env.BACKGROUND_JOBS_INLINE); // deferred unless 'true'
const originChecksEnabled = () => !isFalse(process.env.ORIGIN_CHECKS_ENABLED); // on unless 'false' (row 13)

module.exports = {
  workforceEnabled,
  apiCacheEnabled,
  rateLimitsEnabled,
  requestLogsEnabled,
  backgroundJobsInline,
  originChecksEnabled,
};
