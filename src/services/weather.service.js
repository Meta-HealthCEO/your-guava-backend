const axios = require('axios');

// In-memory cache: { key -> { data, fetchedAt } }
const weatherCache = new Map();
const pendingWeatherRequests = new Map();
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

const cacheKeyFor = (lat, lng, dateStr) => `${lat},${lng},${dateStr}`;

const readCache = (cacheKey) => {
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
};

const normaliseDay = (dayData) => {
  if (!dayData?.day) return null;

  const day = dayData.day;
  const conditionText = day.condition?.text || 'Clear';
  const isRain = conditionText.toLowerCase().includes('rain') ||
    conditionText.toLowerCase().includes('drizzle') ||
    conditionText.toLowerCase().includes('shower') ||
    Number(day.totalprecip_mm || 0) > 0 ||
    Number(day.daily_chance_of_rain || 0) >= 50;

  return {
    temp: day.avgtemp_c ?? DEFAULT_WEATHER.temp,
    condition: conditionText,
    humidity: day.avghumidity ?? DEFAULT_WEATHER.humidity,
    isRain,
    precipMm: Number(day.totalprecip_mm ?? DEFAULT_WEATHER.precipMm),
    chanceOfRain: Number(day.daily_chance_of_rain ?? DEFAULT_WEATHER.chanceOfRain),
  };
};

const rememberDay = (lat, lng, dayData) => {
  const result = normaliseDay(dayData);
  if (!result || !dayData.date) return null;

  weatherCache.set(cacheKeyFor(lat, lng, dayData.date), { data: result, fetchedAt: Date.now() });
  return result;
};

const runDedupe = async (pendingKey, fn) => {
  if (pendingWeatherRequests.has(pendingKey)) {
    return pendingWeatherRequests.get(pendingKey);
  }

  const promise = fn().finally(() => pendingWeatherRequests.delete(pendingKey));
  pendingWeatherRequests.set(pendingKey, promise);
  return promise;
};

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
  const cacheKey = cacheKeyFor(lat, lng, dateStr);

  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const useHistory = isPastDate(targetDate);
    const pendingKey = useHistory ? `history:${cacheKey}` : `forecast:${lat},${lng}`;
    const response = await runDedupe(pendingKey, () =>
      axios.get(`${baseUrl}/${useHistory ? 'history.json' : 'forecast.json'}`, {
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
      })
    );

    const forecastDays = response.data?.forecast?.forecastday || [];
    for (const forecastDay of forecastDays) {
      rememberDay(lat, lng, forecastDay);
    }

    const result = readCache(cacheKey);
    if (!result) {
      return { ...DEFAULT_WEATHER };
    }
    return result;
  } catch (error) {
    console.error('[weather] API error:', error.message);
    return { ...DEFAULT_WEATHER };
  }
};

const clearWeatherCache = () => {
  weatherCache.clear();
  pendingWeatherRequests.clear();
};

module.exports = { getWeatherForecast, clearWeatherCache };
