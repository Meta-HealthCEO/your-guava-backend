const errorMiddleware = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  const requestId = req.id || req.requestId;

  // Map common Mongoose errors to 4xx so client mistakes aren't logged as 500s.
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join('; ') || 'Validation failed';
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.code === 11000) {
    statusCode = 409;
    const field = err.keyPattern ? Object.keys(err.keyPattern)[0] : 'field';
    message = `A record with this ${field} already exists.`;
  }

  if (statusCode >= 500) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'request_error',
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      message: err.message || message,
      stack: err.stack,
    }));
  }

  if (statusCode >= 500 && process.env.NODE_ENV === 'production') {
    message = 'Internal Server Error';
  }

  const exposeDetails = err.details && !(statusCode >= 500 && process.env.NODE_ENV === 'production');

  res.status(statusCode).json({
    success: false,
    message,
    ...(requestId ? { requestId } : {}),
    ...(exposeDetails ? { details: err.details } : {}),
  });
};

module.exports = errorMiddleware;
