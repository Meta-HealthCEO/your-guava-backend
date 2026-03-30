const app = require('./app');
const connectDB = require('./config/db');

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  const server = app.listen(PORT, () => {
    console.log(`Your Guava API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use. Run: npx kill-port ${PORT}`);
      process.exit(1);
    }
  });
};

start();
