const DEFAULT_TRUST_PROXY_HOPS = 1;
const MAX_TRUST_PROXY_HOPS = 5;
const HOPS_ERROR = `TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUST_PROXY_HOPS}`;

/**
 * How many reverse proxies sit in front of the API (security-9). 0 trusts no X-Forwarded-For at all; Railway today is 1.
 * Too few hops lets every user share the edge IP; too many lets a client choose its own rate-limit key.
 */
const parseTrustProxyHops = (raw = process.env.TRUST_PROXY_HOPS) => {
  if (raw === undefined || String(raw).trim() === '') return { hops: DEFAULT_TRUST_PROXY_HOPS, error: null };
  const text = String(raw).trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_TRUST_PROXY_HOPS) {
    return { hops: DEFAULT_TRUST_PROXY_HOPS, error: HOPS_ERROR };
  }
  return { hops: Number(text), error: null };
};

const trustProxyHops = () => parseTrustProxyHops().hops;

const configureTrustProxy = (app) => {
  app.set('trust proxy', trustProxyHops());
  return app;
};

module.exports = { DEFAULT_TRUST_PROXY_HOPS, MAX_TRUST_PROXY_HOPS, parseTrustProxyHops, trustProxyHops, configureTrustProxy };
