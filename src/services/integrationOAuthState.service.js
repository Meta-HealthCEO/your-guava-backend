const crypto = require('crypto');
const IntegrationOAuthState = require('../models/IntegrationOAuthState.model');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_STATE_LENGTH = 256;

const hashState = (state) =>
  crypto.createHash('sha256').update(state, 'utf8').digest('hex');

const createIntegrationOAuthState = async ({ cafeId, userId, provider }) => {
  const state = crypto.randomBytes(32).toString('base64url');
  await IntegrationOAuthState.create({
    stateHash: hashState(state),
    cafeId,
    userId,
    provider,
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
  });
  return state;
};

const consumeIntegrationOAuthState = async ({
  state,
  cafeId,
  userId,
  provider,
}) => {
  if (
    typeof state !== 'string' ||
    state.length < 32 ||
    state.length > MAX_STATE_LENGTH
  ) {
    return false;
  }

  const consumed = await IntegrationOAuthState.findOneAndUpdate(
    {
      stateHash: hashState(state),
      cafeId,
      userId,
      provider,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: true }
  ).lean();

  return Boolean(consumed);
};

module.exports = {
  createIntegrationOAuthState,
  consumeIntegrationOAuthState,
  hashState,
};
