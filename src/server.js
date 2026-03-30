const { execSync } = require('child_process');
const app = require('./app');
const connectDB = require('./config/db');

const PORT = process.env.PORT || 5000;

const start = async () => {
  // Auto-kill any process holding the port (dev only)
  if (process.env.NODE_ENV !== 'production') {
    try {
      execSync(`npx kill-port ${PORT}`, { stdio: 'ignore', timeout: 5000 });
    } catch (_) {
      // Port was free, nothing to kill
    }
  }

  await connectDB();
  app.listen(PORT, () => {
    console.log(`Your Guava API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
};

start();
