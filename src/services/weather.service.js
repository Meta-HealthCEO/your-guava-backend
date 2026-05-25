const axios = require('axios');

// In-memory cache: { key -> { data, fetchedAt } }
const weatherCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_WEATHER = {
  temp: 22,
  condition: 'Clear',
  humidity: 60,
  isRain: false,
  precipMm: 0,
  chanceOfRain: 0,
};

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const isPastDate = (date) => startOfDay(date).getTime() < startOfDay(new Date()).getTime();

/**
 * Fetches the weather forecast/history for a given lat/lng and date.
 * Uses WeatherAPI.com /history.json for past dates and /forecast.json otherwise.
 * Falls back to defaults on any error.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Date|string} date
 * @returns {Promise<{ temp: number, condition: string, humidity: number, isRain: boolean, precipMm: number, chanceOfRain: number }>}
 */
const getWeatherForecast = async (lat, lng, date) => {
  const apiKey = process.env.WEATHER_API_KEY;
  const baseUrl = process.env.WEATHER_API_URL;

  if (!apiKey || !baseUrl) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[weather] WEATHER_API_KEY or WEATHER_API_URL not set, using defaults');
    }
    return { ...DEFAULT_WEATHER };
  }

  const targetDate = new Date(date);
  const dateStr = toDateKey(targetDate);
  const cacheKey = `${lat},${lng},${dateStr}`;

  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const useHistory = isPastDate(targetDate);
    const response = await axios.get(`${baseUrl}/${useHistory ? 'history.json' : 'forecast.json'}`, {
      params: useHistory
        ? {
            key: apiKey,
            q: `${lat},${lng}`,
            dt: dateStr,
          }
        : {
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
      conditionText.toLowerCase().includes('shower') ||
      Number(day.totalprecip_mm || 0) > 0 ||
      Number(day.daily_chance_of_rain || 0) >= 50;

    const result = {
      temp: day.avgtemp_c ?? DEFAULT_WEATHER.temp,
      condition: conditionText,
      humidity: day.avghumidity ?? DEFAULT_WEATHER.humidity,
      isRain,
      precipMm: Number(day.totalprecip_mm ?? DEFAULT_WEATHER.precipMm),
      chanceOfRain: Number(day.daily_chance_of_rain ?? DEFAULT_WEATHER.chanceOfRain),
    };

    weatherCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (error) {
    console.error('[weather] API error:', error.message);
    return { ...DEFAULT_WEATHER };
  }
};

module.exports = { getWeatherForecast };
