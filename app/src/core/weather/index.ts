// 天气：按城市名取今明两天的气温与降水。数据源 Open-Meteo（免费、无需密钥）。
// 失败或断网返回 null，不影响其他功能；不新增依赖，直接用 fetch。
export interface WeatherDay {
  date: string
  tempMin: number
  tempMax: number
  precipitation: number
}

export interface Weather {
  today: WeatherDay
  tomorrow: WeatherDay
}

export interface WeatherOptions {
  fetch?: typeof fetch
}

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export async function getWeather(city: string, options: WeatherOptions = {}): Promise<Weather | null> {
  if (typeof city !== 'string' || city.trim() === '') return null
  const doFetch = options.fetch ?? fetch
  try {
    const geoUrl = `${GEOCODING_URL}?name=${encodeURIComponent(city.trim())}&count=1&language=zh&format=json`
    const geoResp = await doFetch(geoUrl)
    if (!geoResp.ok) return null
    const geo = await geoResp.json() as { results?: { latitude?: unknown; longitude?: unknown }[] }
    const place = geo.results?.[0]
    if (!place || !isFiniteNumber(place.latitude) || !isFiniteNumber(place.longitude)) return null

    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
      timezone: 'auto',
      forecast_days: '2',
    })
    const forecastResp = await doFetch(`${FORECAST_URL}?${params.toString()}`)
    if (!forecastResp.ok) return null
    const forecast = await forecastResp.json() as {
      daily?: { time?: unknown; temperature_2m_max?: unknown; temperature_2m_min?: unknown; precipitation_sum?: unknown }
    }
    const daily = forecast.daily
    if (!daily) return null
    const time = daily.time
    const max = daily.temperature_2m_max
    const min = daily.temperature_2m_min
    const prec = daily.precipitation_sum
    if (!Array.isArray(time) || !Array.isArray(max) || !Array.isArray(min) || !Array.isArray(prec)) return null
    if (time.length < 2 || max.length < 2 || min.length < 2 || prec.length < 2) return null
    const day = (index: number): WeatherDay | null => {
      const date = time[index]
      const tempMax = max[index]
      const tempMin = min[index]
      const precipitation = prec[index]
      if (typeof date !== 'string' || !isFiniteNumber(tempMax) || !isFiniteNumber(tempMin) || !isFiniteNumber(precipitation)) return null
      return { date, tempMax, tempMin, precipitation }
    }
    const today = day(0)
    const tomorrow = day(1)
    if (!today || !tomorrow) return null
    return { today, tomorrow }
  } catch {
    return null
  }
}
