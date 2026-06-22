const notFoundMiddleware = (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    requestId: req.id,
  });
};

module.exports = notFoundMiddleware;
