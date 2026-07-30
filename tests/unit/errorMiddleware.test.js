const errorMiddleware = require('../../src/middleware/error.middleware');

const createResponse = () => {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
};

describe('error middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('does not expose messages or details for production server errors', () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = createResponse();

    errorMiddleware(
      Object.assign(new Error('provider secret leaked'), {
        statusCode: 502,
        details: { providerMessage: 'sensitive upstream response' },
      }),
      { id: 'request-1', method: 'GET', path: '/api/example' },
      response,
      jest.fn()
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal Server Error',
      requestId: 'request-1',
    });
  });

  it('preserves structured details for expected client errors', () => {
    process.env.NODE_ENV = 'production';
    const response = createResponse();

    errorMiddleware(
      Object.assign(new Error('Invalid request'), {
        statusCode: 400,
        details: { code: 'INVALID_REQUEST' },
      }),
      { method: 'POST', path: '/api/example' },
      response,
      jest.fn()
    );

    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Invalid request',
      details: { code: 'INVALID_REQUEST' },
    });
  });
});
