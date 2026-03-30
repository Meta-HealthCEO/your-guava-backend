require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.routes');
const cafeRoutes = require('./routes/cafe.routes');
const transactionsRoutes = require('./routes/transactions.routes');
const forecastsRoutes = require('./routes/forecasts.routes');
const yocoRoutes = require('./routes/yoco.routes');
const eventsRoutes = require('./routes/events.routes');
const teamRoutes = require('./routes/team.routes');
const errorMiddleware = require('./middleware/error.middleware');

const app = express();

// CORS
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/cafe', cafeRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/forecasts', forecastsRoutes);
app.use('/api/yoco', yocoRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/team', teamRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, message: 'Your Guava API is running' });
});

// Global error handler (must be last)
app.use(errorMiddleware);

module.exports = app;
