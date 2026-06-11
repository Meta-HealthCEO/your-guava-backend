const cacheStore = new Map();

const normaliseQuery = (query = {}) =>
  Object.keys(query)
    .filter((key) => key !== 'refresh' && key !== '_')
    .sort()
    .map((key) => `${key}=${JSON.stringify(query[key])}`)
    .join('&');

const trimCache = (maxEntries) => {
  while (cacheStore.size > maxEntries) {
    const oldestKey = cacheStore.keys().next().value;
    cacheStore.delete(oldestKey);
  }
};

const apiCache = ({ ttlMs = 30000, keyPrefix = 'api', maxEntries = 250 } = {}) => (req, res, next) => {
  if (process.env.NODE_ENV === 'test' || req.method !== 'GET' || req.query.refresh === 'true') {
    return next();
  }

  const scope = [
    req.user?.orgId || 'no-org',
    req.user?.cafeId || 'no-cafe',
    req.user?.id || 'no-user',
  ].join(':');
  const cacheKey = `${keyPrefix}:${scope}:${req.baseUrl}${req.path}?${normaliseQuery(req.query)}`;
  const cached = cacheStore.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < ttlMs) {
    res.set('X-Guava-Cache', 'hit');
    return res.status(cached.statusCode).json(cached.body);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cacheStore.set(cacheKey, {
        statusCode: res.statusCode,
        body,
        cachedAt: Date.now(),
      });
      trimCache(maxEntries);
      res.set('X-Guava-Cache', 'miss');
    }
    return originalJson(body);
  };

  return next();
};

const clearApiCache = () => cacheStore.clear();

module.exports = { apiCache, clearApiCache };
