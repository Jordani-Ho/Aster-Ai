import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const output = new URL('../../../bazi-bundle/',import.meta.url)
const report = JSON.parse(readFileSync(new URL('bundle-report.json',output),'utf8'))
assert.equal(report.eagerTimezoneModules,0)
assert.ok(report.timezoneGzipBytes<=150000)
// Run the actual production ESM chunks, not Vitest's module transform.
// No browser globals or implicit Node tzdata lookup should be required.
const {toBazi,ageAt} = await import(new URL('bazi.mjs',output))
const city={nameZh:'澳门',nameEn:'Macau',longitude:113.54611,timeZone:'Asia/Macau'}
const result=await toBazi({date:'1948-07-01',time:'13:30',city})
assert.equal(result.hour[1],'午')
const singapore=await toBazi({date:'1935-07-01',time:'13:10',city:{...city,timeZone:'Asia/Singapore',longitude:103.85007}})
assert.equal(singapore.hour[1],'午')
assert.equal(ageAt('2000-02-29','2023-03-01'),23)
console.log(JSON.stringify({timezoneGzipBytes:report.timezoneGzipBytes,eagerTimezoneModules:0,productionChunkSmoke:'passed'},null,2))
