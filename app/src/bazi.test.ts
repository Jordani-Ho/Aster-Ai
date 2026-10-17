import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { toBazi, ageAt, cities, type City } from '../../domain/tcm/bazi'
import fixtures from '../../domain/tcm/bazi/fixtures.json'
import { approximateLongitude, referenceKnown, referenceDay, type KnownCase } from '../../domain/tcm/bazi/testing/reference'

const beijing: City = { nameZh: '北京', nameEn: 'Beijing', longitude: 116.39723, timeZone: 'Asia/Shanghai' }
const ny: City = { nameZh: '纽约', nameEn: 'New York', longitude: -74.00597, timeZone: 'America/New_York' }
describe('M1-03 sourced fixtures and independent oracle', () => {
  it('has at least 20 sourced cases and both sides of all 12 jie', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(20)
    expect(fixtures.terms).toHaveLength(12)
    const xml = readFileSync(new URL('../../domain/tcm/bazi/testing/hko-2024.xml', import.meta.url), 'utf8')
    const officialRows = [...xml.matchAll(/<M>(\d+)<\/M><D>(\d+)<\/D><hm>([^<]+)<\/hm>/g)].filter((_,i)=>i%2===0)
    expect(fixtures.terms.map(t=>t.hkt)).toEqual(officialRows.map(r=>`2024-${r[1]}-${r[2]}T${r[3]}:00+08:00`))
    for (const term of fixtures.terms) {
      expect(fixtures.cases.some(c => c.id === term.name + '-before')).toBe(true)
      expect(fixtures.cases.some(c => c.id === term.name + '-after')).toBe(true)
      // Independent USNO approximate longitude only checks transcription, not minute precision.
      const error = ((approximateLongitude(Date.parse(term.utc)) - term.longitude + 540) % 360) - 180
      expect(Math.abs(error)).toBeLessThan(0.03)
    }
    const reference = readFileSync(new URL('../../domain/tcm/bazi/testing/reference.ts', import.meta.url), 'utf8')
    expect(reference).not.toMatch(/^import .*from .*lunar-typescript/m)
  })
  for (const row of fixtures.cases as KnownCase[]) {
    it(row.id, () => {
      expect(row.sources.official).toMatch(/^https:\/\/www.hko.gov.hk\//)
      expect(row.sources.independent.length).toBeGreaterThanOrEqual(2)
      expect(referenceKnown(row, fixtures.terms)).toEqual(row.expected)
      const actual = toBazi({ date: row.date, time: row.time,
        city: { ...beijing, longitude: row.longitude, timeZone: row.timeZone },
        occurrence: row.id.endsWith('fold-later') ? 'later' : 'earlier',
      }, { ziHourRule: row.ziHourRule })
      expect(actual).toMatchObject(row.expected)
      expect(actual.ambiguous).toBeUndefined()
      // Results never carry the original birthday, birth clock or resolved UTC.
      expect(actual).not.toHaveProperty('utc')
      expect(actual).not.toHaveProperty('birth')
    })
  }
})
describe('M1-03 missing time and approximate ranges', () => {
  it('returns null hour and 时柱缺 on a non-jie date, even with solar/zi options', () => {
    const r = toBazi({date:'2024-02-10',time:null,city:beijing},{trueSolarTime:true,ziHourRule:'nextDay'})
    expect(r).toMatchObject({year:'甲辰',month:'丙寅',day:referenceDay('2024-02-10'),hour:null,flags:['时柱缺']})
    expect(r.ambiguous).toBeUndefined()
  })
  it('returns two year/month candidates on spring day, without filling in a clock time', () => {
    const r = toBazi({date:'2024-02-04',time:null,city:beijing})
    expect(r).toMatchObject({year:null,month:null,day:referenceDay('2024-02-04'),hour:null,flags:['时柱缺'],ambiguous:{
      pillars:['year','month'],term:'立春',termTime:'16:27',
      before:{year:'癸卯',month:'乙丑'},after:{year:'甲辰',month:'丙寅'},
    }})
  })
  it('a range wholly after the term resolves year/month, but never invents an hour', () => {
    const r = toBazi({date:'2024-02-04',time:null,timeRange:{start:'17:00',end:'19:00'},city:beijing})
    expect(r).toMatchObject({year:'甲辰',month:'丙寅',hour:null,flags:['时柱缺']})
    expect(r.ambiguous).toBeUndefined()
  })
  it('before and crossing ranges resolve or retain candidates', () => {
    expect(toBazi({date:'2024-02-04',city:beijing,timeRange:{start:'13:00',end:'16:00'}})).toMatchObject({year:'癸卯',month:'乙丑'})
    expect(toBazi({date:'2024-02-04',city:beijing,timeRange:{start:'13:00',end:'17:00'}}).ambiguous).toBeDefined()
  })
  it('non-spring jie marks only the month ambiguous', () => {
    const r = toBazi({date:'2024-03-05',city:beijing})
    expect(r.year).toBe('甲辰')
    expect(r.month).toBeNull()
    expect(r.ambiguous?.pillars).toEqual(['month'])
  })
  it('overseas ambiguity follows the local calendar date', () => {
    const r = toBazi({date:'2024-02-04',city:ny})
    expect(r.ambiguous?.termTime).toBe('03:27')
    expect(toBazi({date:'2024-02-03',city:ny}).ambiguous).toBeUndefined()
  })
})
describe('M1-03 clock rules', () => {
  it('rejects DST gaps and offers both occurrences of a fold, default earlier', () => {
    expect(() => toBazi({date:'2024-03-10',time:'02:30',city:ny})).toThrow(/NONEXISTENT_LOCAL_TIME/)
    const birth = {date:'2024-11-03',time:'01:30',city:ny}
    const earlier = toBazi(birth)
    const later = toBazi({...birth,occurrence:'later'})
    expect(earlier.repeatedTime).toEqual({selected:'earlier',choices:['earlier','later']})
    expect(later.repeatedTime?.selected).toBe('later')
    expect(earlier.hour).not.toBe(later.hour) // standard clock is 00:30 vs 01:30
  })
  it('China historical DST is deducted, including a day crossing', () => {
    const a = toBazi({date:'1988-07-01',time:'00:30',city:beijing},{ziHourRule:'sameDay'})
    expect(a.day).toBe(referenceDay('1988-06-30'))
    expect(a.hour?.[1]).toBe('子')
    expect(() => toBazi({date:'1988-04-17',time:'02:30',city:beijing})).toThrow(/NONEXISTENT_LOCAL_TIME/)
  })
  it('zi rules change only the day at 23:00, with equal time stems', () => {
    const birth = {date:'2024-02-10',time:'23:00',city:beijing}
    const next = toBazi(birth)
    const same = toBazi(birth,{ziHourRule:'sameDay'})
    expect(next.day).toBe('乙巳')
    expect(same.day).toBe('甲辰')
    expect(next.hour).toBe('丙子')
    expect(same.hour).toBe(next.hour)
  })
  it('handles half-hour DST and multi-year wartime summer time', () => {
    const lordHowe = {...beijing,longitude:159.08333,timeZone:'Australia/Lord_Howe'}
    const a = toBazi({date:'2024-01-15',time:'13:15',city:lordHowe}) // standard 12:45
    expect(a.hour?.[1]).toBe('午')
    const london = {...beijing,longitude:-0.12574,timeZone:'Europe/London'}
    const b = toBazi({date:'1941-07-01',time:'14:30',city:london}) // double summer time: standard 12:30
    expect(b.hour?.[1]).toBe('午')
    expect(b.day).toBe(referenceDay('1941-07-01'))
  })
  // BLOCKING known failures, not accepted behavior. Remove .fails after the proposed
  // historical-standard-offset dependency is approved and these cases really pass.
  // Intl's numeric GMT names contain no DST/standard distinction.
  it.fails('BLOCKER: Macau 1948 numeric GMT name hides a one-hour DST saving', () => {
    const city = {...beijing,timeZone:'Asia/Macau',longitude:113.54611}
    expect(toBazi({date:'1948-07-01',time:'13:30',city}).hour?.[1]).toBe('午') // standard 12:30
  })
  it.fails('BLOCKER: Singapore 1935 numeric GMT name hides a twenty-minute saving', () => {
    const city = {...beijing,timeZone:'Asia/Singapore',longitude:103.85007}
    expect(toBazi({date:'1935-07-01',time:'13:10',city}).hour?.[1]).toBe('午') // standard 12:50
  })
  it('15 degrees equals one solar hour, independently of the configured time zone', () => {
    const west = {...beijing,longitude:105}
    const east = {...beijing,longitude:120}
    const options = {trueSolarTime:true}
    expect(toBazi({date:'2024-02-10',time:'14:10',city:west},options)).toEqual(
      toBazi({date:'2024-02-10',time:'13:10',city:east},options))
    expect(toBazi({date:'2024-02-10',time:'14:10',city:west},options).hour).not.toBe(
      toBazi({date:'2024-02-10',time:'14:10',city:east},options).hour)
    // 14:10 local = 06:10 UTC, EOT ~ -14 minutes: longitude120 => 13:56.
    expect(toBazi({date:'2024-02-10',time:'14:10',city:east},options).hour?.[1]).toBe('未')
  })
  it('solar correction may cross a day but never shifts absolute year/month boundaries', () => {
    const birth = {date:'2024-02-04',time:'16:25',city:{...beijing,longitude:-170}}
    const normal = toBazi(birth)
    const solar = toBazi(birth,{trueSolarTime:true})
    expect([solar.year,solar.month]).toEqual([normal.year,normal.month])
    expect(solar.day).not.toBe(normal.day)
  })
  it('two sourced cities near 15 degrees apart differ by approximately one solar hour', () => {
    const west = cities.find(c=>c.nameEn==='Xining')!
    const east = cities.find(c=>c.nameEn==='Beijing')!
    expect((east.longitude-west.longitude)*4).toBeGreaterThan(55)
    expect((east.longitude-west.longitude)*4).toBeLessThan(65)
    expect(toBazi({date:'2024-02-10',time:'14:10',city:west},{trueSolarTime:true}).hour?.[1]).toBe('午')
    expect(toBazi({date:'2024-02-10',time:'14:10',city:east},{trueSolarTime:true}).hour?.[1]).toBe('未')
  })
  it('is independent of the host default time zone', () => {
    const saved = process.env.TZ
    const birth = {date:'2024-02-04',time:'16:25',city:beijing}
    const expected = toBazi(birth)
    try {
      for(const zone of ['UTC','America/Los_Angeles','Pacific/Auckland']) {
        process.env.TZ = zone
        expect(toBazi(birth)).toEqual(expected)
      }
    } finally {
      if(saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })
  it('accepts supported endpoints and rejects malformed dates/times/options', () => {
    for(const date of ['1900-01-01','2100-12-31']) expect(toBazi({date,time:'12:00',city:beijing}).day).toBe(referenceDay(date))
    for(const date of ['1899-12-31','2101-01-01','2024-02-30','2023-02-29','2024-2-10']) {
      expect(() => toBazi({date,time:'12:00',city:beijing})).toThrow()
    }
    for(const time of ['24:00','12:60','12:00:01']) expect(()=>toBazi({date:'2024-02-10',time,city:beijing})).toThrow()
    expect(()=>toBazi({date:'2024-02-10',city:{...beijing,timeZone:'Invalid/Zone'}})).toThrow()
    expect(()=>toBazi({date:'2024-02-10',city:{...beijing,longitude:NaN}})).toThrow()
    expect(()=>toBazi({date:'2024-02-10',city:beijing,timeRange:{start:'17:00',end:'13:00'}})).toThrow()
  })
})
describe('M1-03 age and offline city data', () => {
  it('full years change on the birthday, with leap-day birthday on March 1 in common years', () => {
    expect(ageAt('2000-06-15','2024-06-14')).toBe(23)
    expect(ageAt('2000-06-15','2024-06-15')).toBe(24)
    expect(ageAt('2000-02-29','2023-02-28')).toBe(22)
    expect(ageAt('2000-02-29','2023-03-01')).toBe(23)
    expect(ageAt('2000-02-29','2024-02-28')).toBe(23)
    expect(ageAt('2000-02-29','2024-02-29')).toBe(24)
    expect(ageAt('2024-02-10','2024-02-10')).toBe(0)
    expect(()=>ageAt('2024-02-10','2024-02-09')).toThrow()
    expect(()=>ageAt('2023-02-29','2024-03-01')).toThrow()
  })
  it('ships a compact attributed city table with valid coordinates and Intl time zones', () => {
    expect(cities.length).toBeGreaterThan(300)
    expect(statSync(new URL('../../domain/tcm/bazi/cities.json',import.meta.url)).size).toBeLessThan(300*1024)
    for(const city of cities) {
      expect(city.nameZh).toMatch(/[\u3400-\u9fff]/)
      expect(city.nameEn).not.toBe('')
      expect(Math.abs(city.longitude)).toBeLessThanOrEqual(180)
      expect(()=>new Intl.DateTimeFormat('en',{timeZone:city.timeZone})).not.toThrow()
    }
    for(const name of ['Beijing','Shanghai','New York City','Sydney','Singapore','Toronto']) {
      expect(cities.some(c=>c.nameEn===name)).toBe(true)
    }
  })
})
