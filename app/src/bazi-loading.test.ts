import { describe, expect, it, vi } from 'vitest'
import { toBazi } from '../../domain/tcm/bazi'
import fixtures from '../../domain/tcm/bazi/fixtures.json'

describe('M1-03 single timezone data source', () => {
  it('ignores incorrect Intl time-zone results on the first and later conversions', async () => {
    const Native = Intl.DateTimeFormat
    // Simulate a phone that incorrectly treats every time zone as UTC.
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function(locales, options) {
      return new Native(locales, {...options,timeZone:'UTC'})
    })
    try {
      for(const id of ['beijing-1988-dst','new-york-fold-earlier','new-york-fold-later','sydney-summer']) {
        const row = fixtures.cases.find(c=>c.id===id)!
        const result = await toBazi({date:row.date,time:row.time,
          city:{nameZh:'合成测试',nameEn:'Synthetic fixture',longitude:row.longitude,timeZone:row.timeZone},
          occurrence:id.endsWith('fold-later')?'later':'earlier',
        },{ziHourRule:row.ziHourRule as 'sameDay'|'nextDay'})
        expect(result).toMatchObject(row.expected)
      }
      const city = {nameZh:'北京',nameEn:'Beijing',longitude:116.39723,timeZone:'Asia/Shanghai'}
      const missing = await toBazi({date:'2024-02-04',time:null,city})
      expect(missing.ambiguous).toMatchObject({term:'立春',termTime:'16:27',
        before:{year:'癸卯',month:'乙丑'},after:{year:'甲辰',month:'丙寅'}})
      await expect(toBazi({date:'1988-04-17',time:'02:30',city})).rejects.toThrow(/NONEXISTENT_LOCAL_TIME/)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
