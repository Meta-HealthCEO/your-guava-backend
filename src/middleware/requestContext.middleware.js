const crypto = require('crypto');

const REQUEST_ID_HEADER = 'X-Request-Id';
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

const logsEnabled = () =>
  process.env.NODE_ENV !== 'test' &&
  String(process.env.REQUEST_LOGS_ENABLED || 'true').toLowerCase() !== 'false';

const generateRequestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
};

// Routers strip their mount prefix from req.path, so by the time the response
// finishes "/api/auth/me" reads as "/me". originalUrl keeps the full path; the
// query string is dropped because it can carry tokens.
const requestPath = (req) => String(req.originalUrl || req.url || '').split('?')[0];

const requestContext = (req, res, next) => {
  const incomingId = String(req.get(REQUEST_ID_HEADER) || '').trim();
  const requestId = REQUEST_ID_PATTERN.test(incomingId) ? incomingId : generateRequestId();

  req.id = requestId;
  req.requestId = requestId;
  req.startedAt = Date.now();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};

const requestLogger = (req, res, next) => {
  if (!logsEnabled()) return next();

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const log = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      event: 'http_request',
      requestId: req.id,
      method: req.method,
      path: requestPath(req),
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      contentLength: Number(res.getHeader('content-length') || 0),
    };

    if (req.user?.id) log.userId = String(req.user.id);
    if (req.user?.cafeId) log.cafeId = String(req.user.cafeId);

    const line = JSON.stringify(log);
    if (res.statusCode >= 500) console.error(line);
    else console.info(line);
  });

  next();
};

module.exports = {
  REQUEST_ID_HEADER,
  requestContext,
  requestLogger,
};
