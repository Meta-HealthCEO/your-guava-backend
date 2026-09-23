const uploadsRouter = require('../../src/routes/uploads.routes');
const { parseLimiter, getLimiterOptions } = require('../../src/middleware/rateLimit.middleware');

const handlersFor = (method, routePath) => {
  const layer = uploadsRouter.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer ? layer.route.stack.map((entry) => entry.handle) : [];
};

describe('confirm and remap have their own parsing budget', () => {
  it.each([['post', '/:id/confirm'], ['patch', '/:id/mapping']])('%s %s runs the parse limiter', (method, routePath) => {
    expect(parseLimiter).toEqual(expect.any(Function));
    expect(handlersFor(method, routePath)).toContain(parseLimiter);
  });

  it('allows twenty parses a minute per user', () => {
    expect(getLimiterOptions('parse')).toEqual({ limit: 20, windowMs: 60 * 1000 });
  });

  it('leaves the read routes without a parse limiter', () => {
    for (const [method, routePath] of [['get', '/'], ['get', '/:id'], ['get', '/:id/rows']]) {
      expect(handlersFor(method, routePath)).not.toContain(parseLimiter);
    }
  });
});
