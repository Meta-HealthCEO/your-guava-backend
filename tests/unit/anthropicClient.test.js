const {
  getAnthropicClientOptions,
  asUpstreamAiError,
  withAnthropicErrors,
} = require('../../src/services/anthropicClient.service');

describe('Anthropic client bounds', () => {
  const originalTimeout = process.env.ANTHROPIC_TIMEOUT_MS;
  const originalRetries = process.env.ANTHROPIC_MAX_RETRIES;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.ANTHROPIC_TIMEOUT_MS;
    else process.env.ANTHROPIC_TIMEOUT_MS = originalTimeout;
    if (originalRetries === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
    else process.env.ANTHROPIC_MAX_RETRIES = originalRetries;
  });

  it('uses bounded production defaults', () => {
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    delete process.env.ANTHROPIC_MAX_RETRIES;
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 30_000, maxRetries: 1 })
    );
  });

  it('clamps unsafe timeout and retry values', () => {
    process.env.ANTHROPIC_TIMEOUT_MS = '999999';
    process.env.ANTHROPIC_MAX_RETRIES = '99';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 60_000, maxRetries: 2 })
    );

    process.env.ANTHROPIC_TIMEOUT_MS = '1';
    process.env.ANTHROPIC_MAX_RETRIES = '-5';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 5_000, maxRetries: 0 })
    );
  });
});

describe('Anthropic upstream error wrapping', () => {
  const rawBody = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  // Shape of an @anthropic-ai/sdk APIError: `message` embeds the raw response
  // body, `error` is the parsed body with the API error nested under `.error`.
  const sdkAuthError = () => Object.assign(new Error(`401 ${rawBody}`), {
    name: 'AuthenticationError',
    status: 401,
    error: JSON.parse(rawBody),
  });
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the SDK error as cause and summarises it without the raw response body', () => {
    const cause = sdkAuthError();

    const wrapped = asUpstreamAiError(cause);

    expect(wrapped.statusCode).toBe(503);
    expect(wrapped.message).toMatch(/temporarily unavailable/);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.upstreamStatus).toBe(401);
    expect(wrapped.upstreamMessage).toBe('authentication_error: invalid x-api-key');
    expect(wrapped.upstreamMessage).not.toContain('{');
    // Marks the message as written for the client. error.middleware.js does not
    // read this yet, so in production the owner still sees "Internal Server
    // Error"; the flag is the contract that fix needs to honour.
    expect(wrapped.exposeMessage).toBe(true);
  });

  it('never copies a non-JSON response body into the summary', () => {
    const htmlError = Object.assign(new Error('502 <html>Bad gateway</html>'), {
      name: 'APIError',
      status: 502,
    });

    const wrapped = asUpstreamAiError(htmlError);

    expect(wrapped.upstreamStatus).toBe(502);
    expect(wrapped.upstreamMessage).toBe('APIError');
  });

  it('keeps SDK-generated connection messages and truncates long provider messages', () => {
    const connection = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
    expect(asUpstreamAiError(connection)).toEqual(expect.objectContaining({
      upstreamStatus: null,
      upstreamMessage: 'APIConnectionError: Connection error.',
    }));

    const overloaded = Object.assign(new Error('529 ...'), {
      status: 529,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'y'.repeat(1_000) } },
    });
    const summary = asUpstreamAiError(overloaded).upstreamMessage;
    expect(summary.startsWith('overloaded_error: yyy')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('logs the failed operation with upstream status and type', async () => {
    await expect(
      withAnthropicErrors(async () => { throw sdkAuthError(); }, 'proposeColumnMapping')
    ).rejects.toMatchObject({ statusCode: 503, upstreamStatus: 401 });

    expect(logSpy).toHaveBeenCalledWith(
      '[anthropic] proposeColumnMapping failed: status=401 type=authentication_error'
    );
  });

  it('rethrows client aborts untouched and unlogged', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    await expect(withAnthropicErrors(async () => { throw abort; })).rejects.toBe(abort);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
