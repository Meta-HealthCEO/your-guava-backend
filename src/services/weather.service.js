const axios = require('axios');

// In-memory cache: { key -> { data, fetchedAt } }
const weatherCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_WEATHER = {
  temp: 22,
  condition: 'Clear',
  humidity: 60,
  isRain: false,
};

/**
 * Fetches the weather forecast for a given lat/lng and date.
 * Uses WeatherAPI.com /forecast.json endpoint (up to 7 days ahead).
 * Falls back to defaults on any error.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Date|string} date
 * @returns {Promise<{ temp: number, condition: string, humidity: number, isRain: boolean }>}
 */
const getWeatherForecast = async (lat, lng, date) => {
  const apiKey = process.env.WEATHER_API_KEY;
  const baseUrl = process.env.WEATHER_API_URL;

  if (!apiKey || !baseUrl) {
    console.warn('[weather] WEATHER_API_KEY or WEATHER_API_URL not set, using defaults');
    return { ...DEFAULT_WEATHER };
  }

  const targetDate = new Date(date);
  const dateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const cacheKey = `${lat},${lng},${dateStr}`;

  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await axios.get(`${baseUrl}/forecast.json`, {
      params: {
        key: apiKey,
        q: `${lat},${lng}`,
        days: 7,
      },
      timeout: 8000,
    });

    const forecastDays = response.data?.forecast?.forecastday || [];
    const dayData = forecastDays.find((d) => d.date === dateStr);

    if (!dayData) {
      return { ...DEFAULT_WEATHER };
    }

    const day = dayData.day;
    const conditionText = day.condition?.text || 'Clear';
    const isRain = conditionText.toLowerCase().includes('rain') ||
      conditionText.toLowerCase().includes('drizzle') ||
      conditionText.toLowerCase().includes('shower');

    const result = {
      temp: day.avgtemp_c ?? DEFAULT_WEATHER.temp,
      condition: conditionText,
      humidity: day.avghumidity ?? DEFAULT_WEATHER.humidity,
      isRain,
    };

    weatherCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (error) {
    console.error('[weather] API error:', error.message);
    return { ...DEFAULT_WEATHER };
  }
};

module.exports = { getWeatherForecast };
