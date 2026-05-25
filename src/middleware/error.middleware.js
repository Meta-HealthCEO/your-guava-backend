const errorMiddleware = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';

  if (err.code === 11000) {
    statusCode = 409;
    message = 'A duplicate record already exists. The import has been stopped before saving more rows.';
  }

  if (statusCode >= 500) {
    console.error(`[Error] ${err.stack || err.message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.details ? { details: err.details } : {}),
  });
};

module.exports = errorMiddleware;
