import { describe, expect, it, vi } from 'vitest'
import { getWeather } from './index'

function responseJson(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
  } as unknown as Response
}

const forecast = {
  daily: {
    time: ['2026-10-17', '2026-10-18'],
    temperature_2m_max: [22.5, 23.1],
    temperature_2m_min: [13.2, 14.0],
    precipitation_sum: [0, 3.4],
  },
}

describe('天气（Open-Meteo）', () => {
  it('按城市取今明两天气温与降水', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(responseJson({ results: [{ latitude: 39.9, longitude: 116.4 }] }))
      .mockResolvedValueOnce(responseJson(forecast))
    const weather = await getWeather('北京', { fetch: mockFetch })
    expect(weather).not.toBeNull()
    expect(weather!.today).toEqual({ date: '2026-10-17', tempMax: 22.5, tempMin: 13.2, precipitation: 0 })
    expect(weather!.tomorrow).toEqual({ date: '2026-10-18', tempMax: 23.1, tempMin: 14.0, precipitation: 3.4 })
  })

  it('城市查不到坐标返回 null', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(responseJson({ results: [] }))
    expect(await getWeather('不存在的城市', { fetch: mockFetch })).toBeNull()
  })

  it('网络失败返回 null（不抛出）', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await getWeather('上海', { fetch: mockFetch })).toBeNull()
  })

  it('预报缺字段返回 null', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(responseJson({ results: [{ latitude: 1, longitude: 1 }] }))
      .mockResolvedValueOnce(responseJson({ daily: { time: ['2026-10-17'] } }))
    expect(await getWeather('广州', { fetch: mockFetch })).toBeNull()
  })
})
