jest.mock('axios');

const axios = require('axios');
const { getWeatherForecast, clearWeatherCache } = require('../../src/services/weather.service');

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('weather service', () => {
  const originalKey = process.env.WEATHER_API_KEY;
  const originalUrl = process.env.WEATHER_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    clearWeatherCache();
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.WEATHER_API_KEY;
    else process.env.WEATHER_API_KEY = originalKey;

    if (originalUrl === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalUrl;
  });

  it('uses WeatherAPI history endpoint for past dates', async () => {
    const past = new Date();
    past.setDate(past.getDate() - 1);
    const dateStr = toDateKey(past);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: dateStr,
              day: {
                avgtemp_c: 15,
                avghumidity: 82,
                totalprecip_mm: 4.2,
                daily_chance_of_rain: 78,
                condition: { text: 'Patchy rain nearby' },
              },
            },
          ],
        },
      },
    });

    const result = await getWeatherForecast(-33.9, 18.4, past);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.weatherapi.com/v1/history.json',
      expect.objectContaining({
        params: expect.objectContaining({ dt: dateStr, q: '-33.9,18.4' }),
      })
    );
    expect(result).toEqual({
      temp: 15,
      condition: 'Patchy rain nearby',
      humidity: 82,
      isRain: true,
      precipMm: 4.2,
      chanceOfRain: 78,
    });
  });

  it('uses WeatherAPI forecast endpoint for current and future dates', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const dateStr = toDateKey(future);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: dateStr,
              day: {
                avgtemp_c: 23,
                avghumidity: 55,
                totalprecip_mm: 0,
                daily_chance_of_rain: 0,
                condition: { text: 'Sunny' },
              },
            },
          ],
        },
      },
    });

    const result = await getWeatherForecast(-33.9, 18.4, future);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.weatherapi.com/v1/forecast.json',
      expect.objectContaining({
        params: expect.objectContaining({ days: 7, q: '-33.9,18.4' }),
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        temp: 23,
        condition: 'Sunny',
        isRain: false,
      })
    );
  });

  it('caches every day from a forecast response for follow-up future dates', async () => {
    const first = new Date();
    first.setDate(first.getDate() + 1);
    const second = new Date();
    second.setDate(second.getDate() + 2);
    const firstStr = toDateKey(first);
    const secondStr = toDateKey(second);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: firstStr,
              day: {
                avgtemp_c: 21,
                avghumidity: 52,
                totalprecip_mm: 0,
                daily_chance_of_rain: 0,
                condition: { text: 'Clear' },
              },
            },
            {
              date: secondStr,
              day: {
                avgtemp_c: 17,
                avghumidity: 72,
                totalprecip_mm: 1.2,
                daily_chance_of_rain: 62,
                condition: { text: 'Light rain' },
              },
            },
          ],
        },
      },
    });

    await getWeatherForecast(-33.9, 18.4, first);
    const secondResult = await getWeatherForecast(-33.9, 18.4, second);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(
      expect.objectContaining({
        temp: 17,
        condition: 'Light rain',
        isRain: true,
      })
    );
  });
});
