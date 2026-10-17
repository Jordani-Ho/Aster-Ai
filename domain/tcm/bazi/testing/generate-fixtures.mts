import { readFileSync, writeFileSync } from 'node:fs'
import { formulaSources, referenceKnown, type Term, type KnownCase } from './reference.ts'
const root = new URL('../', import.meta.url)
const names = ['小寒','立春','惊蛰','清明','立夏','芒种','小暑','立秋','白露','寒露','立冬','大雪']
const official = 'https://www.hko.gov.hk/tc/gts/astronomy/data/files/24SolarTerms_2024.xml'
const xml = readFileSync(new URL('./hko-2024.xml',import.meta.url), 'utf8')
const rows = [...xml.matchAll(/<M>(\d+)<\/M><D>(\d+)<\/D><hm>([^<]+)<\/hm>/g)]
const terms: Term[] = rows.filter((_,i)=>i%2===0).map((r,i)=>{
  const hkt = `2024-${r[1]}-${r[2]}T${r[3]}:00+08:00`
  return { name:names[i], hkt, utc:new Date(hkt).toISOString(), longitude:(285+30*i)%360, source:official }
})
const cases: KnownCase[] = []
function add(id:string, date:string, time:string, offset:number, timeZone='Asia/Shanghai', longitude=116.39723, ziHourRule:'nextDay'|'sameDay'='nextDay', dst=0, source='https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf', locator='HKO 2024 calendar p1; clock minute is a synthetic boundary probe, not a real person') {
  const utcMs = Date.parse(`${date}T${time}:00Z`) - offset * 60000
  const entry = { id,date,time,timeZone,longitude,utc:new Date(utcMs).toISOString(),standard:new Date(utcMs+(offset-dst)*60000).toISOString().slice(0,16),ziHourRule,
    sources:{official:source,locator,independent:formulaSources,method:'HKO official dates/terms + independent JDN/cycle/five-rat formulas in testing/reference.ts; no library-generated expectations'}, expected:{} } as KnownCase
  entry.expected = referenceKnown(entry,terms)
  cases.push(entry)
}
for(const t of terms) for(const delta of [-2,2]) {
  const local = new Date(Date.parse(t.utc) + 8*3600000 + delta*60000).toISOString()
  add(`${t.name}${delta<0?'-before':'-after'}`,local.slice(0,10),local.slice(11,16),480,'Asia/Shanghai',116.39723,'nextDay',0,official,`${t.name}: ${t.hkt}; probe ${delta} minutes from published rounded minute`)
}
for(const date of ['2024-02-03','2024-02-05']) add(`spring-day-${date}`,date,'12:00',480)
for(const time of ['22:59','23:00','23:59','00:00']) for(const rule of ['nextDay','sameDay'] as const) add(`zi-${time}-${rule}`,'2024-02-10',time,480,'Asia/Shanghai',116.39723,rule,0,'https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf','HKO 2024 calendar p1: 10 February is lunar New Year; time probes derived for zi-rule tests')
add('leap-second-month','2023-03-22','12:00',480,'Asia/Shanghai',116.39723,'nextDay',0,'https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2023.pdf','p1 March 22: leap second month day 1; noon probe, solar-month independent of lunar leap month')
add('beijing-1988-dst','1988-07-01','14:00',540,'Asia/Shanghai',116.39723,'nextDay',60,'https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1988.pdf','p1 July 1; synthetic clock 14:00, historical IANA Asia/Shanghai DST UTC+9, standard 13:00')
for(const time of ['03:25','03:30']) add(`new-york-spring-${time}`,'2024-02-04',time,-300,'America/New_York',-74.00597)
add('new-york-summer','2024-07-06','11:00',-240,'America/New_York',-74.00597,'nextDay',60)
add('sydney-summer','2024-02-10','00:30',660,'Australia/Sydney',151.20732,'nextDay',60)
add('new-york-fold-earlier','2024-11-03','01:30',-240,'America/New_York',-74.00597,'nextDay',60)
add('new-york-fold-later','2024-11-03','01:30',-300,'America/New_York',-74.00597)
writeFileSync(new URL('fixtures.json',root),JSON.stringify({
  provenance:'Per approved task card PR #4: official HKO dates + independent formula oracle. Test clock probes are explicitly derived, not published birth records. Expectations generated only by testing/reference.ts.',
  precision:'HKO rounds terms to minutes; boundary probes are +/-2 minutes to avoid rounding ambiguity. Runtime library compares its exact seconds.',terms,cases,
  additionalAcceptance:{unknownSpring:{date:'2024-02-04',time:null,source:official,termHkt:'16:27',before:{year:'癸卯',month:'乙丑'},after:{year:'甲辰',month:'丙寅'},formulaSources},
    unknownRanges:{date:'2024-02-04',ranges:[['13:00','16:00'],['13:00','17:00'],['17:00','19:00']],source:official,independent:formulaSources,method:'Ranges derived around the published 16:27 spring boundary; expected sides determined by comparison, no fabricated birth time'},
    solar:{date:'2024-02-10',time:'14:10',longitudes:[105,120],source:'https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf',independent:'https://gml.noaa.gov/grad/solcalc/solareqns.PDF',method:'Synthetic 15-degree perturbation on an official calendar date, NOAA time_offset equation implies exactly 60 solar minutes for the same UTC instant'},
    ages:{birthdays:['2000-06-15','2000-02-29'],checks:['2024-06-14','2024-06-15','2023-02-28','2023-03-01','2024-02-28','2024-02-29'],source:['https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2000.pdf','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2023.pdf','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf'],independent:'https://aa.usno.navy.mil/faq/asa_glossary',method:'Gregorian dates/leap-day existence cross-check; age arithmetic and March-1 rule fixed by task card, not claimed as an almanac age entry'},
    gap:{date:'2024-03-10',time:'02:30',timeZone:'America/New_York',source:'https://data.iana.org/time-zones/tzdb/northamerica'},
    fold:{date:'2024-11-03',time:'01:30',timeZone:'America/New_York',source:'https://data.iana.org/time-zones/tzdb/northamerica'},
    historicalAndFractionalDst:{cases:[{date:'1988-07-01',time:'00:30',zone:'Asia/Shanghai',standard:'1988-06-30T23:30'},{date:'1988-04-17',time:'02:30',zone:'Asia/Shanghai',error:'NONEXISTENT_LOCAL_TIME'},{date:'1941-07-01',time:'14:30',zone:'Europe/London',standard:'1941-07-01T12:30'},{date:'2024-01-15',time:'13:15',zone:'Australia/Lord_Howe',standard:'2024-01-15T12:45'}],
      sources:['https://data.iana.org/time-zones/tzdb/asia','https://data.iana.org/time-zones/tzdb/europe','https://data.iana.org/time-zones/tzdb/australasia','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1941.pdf','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1988.pdf','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf'],independent:formulaSources,method:'Synthetic clock probes on official calendar dates; civil/standard offsets cross-checked against IANA historical rules; JDN/five-rat expected day/hour independent of library'},
    actualCitiesSolar:{date:'2024-02-10',time:'14:10',cities:['Xining','Beijing'],sources:['https://download.geonames.org/export/dump/CN.zip','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf'],independent:'https://gml.noaa.gov/grad/solcalc/solareqns.PDF',method:'Selected GeoNames city coordinates; 4 minutes per degree and EOT put Xining in 午 and Beijing in 未 at this clock minute'},
    knownBlockingFailures:{status:'NOT ACCEPTED; explicit it.fails regressions, pending timezone dependency approval',cases:[{date:'1948-07-01',time:'13:30',timeZone:'Asia/Macau',standard:'1948-07-01T12:30',expectedHourBranch:'午'},{date:'1935-07-01',time:'13:10',timeZone:'Asia/Singapore',standard:'1935-07-01T12:50',expectedHourBranch:'午'}],sources:['https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1948.pdf','https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1935.pdf','https://data.iana.org/time-zones/tzdb/asia'],independent:formulaSources,method:'Official Gregorian calendar dates + IANA STDOFF/SAVE; independent five-rat rule. Correct expectations currently fail; never use current implementation output as expected.'}}
},null,2)+'\n')
console.log(`Generated ${cases.length} fixture cases from official HKO XML and independent formulas`)
