import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

// Separate library harness: measures M1-03's real lazy graph without adding a UI.
function measureLazyBundle(): Plugin {
  return {
    name:'measure-bazi-lazy-bundle',
    generateBundle(_options,bundle) {
      const chunks = Object.values(bundle).filter(c=>c.type==='chunk')
      const closure = (files: string[]) => {
        const result = new Set<string>()
        const visit = (file: string) => {
          if(result.has(file)) return
          result.add(file)
          const chunk = bundle[file]
          if(chunk?.type==='chunk') chunk.imports.forEach(visit)
        }
        files.forEach(visit)
        return [...result].map(file=>bundle[file]).filter(c=>c?.type==='chunk')
      }
      const isTimezone = (id: string) => /node_modules\/(timezonecomplete|tzdata)\//.test(id.replaceAll('\\','/'))
      const entries = chunks.filter(c=>c.isEntry)
      for(const entry of entries) {
        const eager = closure([entry.fileName])
        if(eager.some(c=>Object.keys(c.modules).some(isTimezone))) this.error('Timezone code/data leaked into the eager entry')
        if(!entry.dynamicImports.length) this.error('Conversion engine must be dynamically imported')
      }
      const timezoneChunks = closure(chunks.filter(c=>Object.keys(c.modules).some(isTimezone)).map(c=>c.fileName))
      const timezoneGzipBytes = timezoneChunks.reduce((n,c)=>n+gzipSync(c.code,{level:6}).length,0)
      if(timezoneGzipBytes>150000) this.error('Timezone bundle exceeds 150 KB gzip: trim data to city time zones')
      const report = {
        timezoneGzipBytes,gzipLevel:6,limitBytes:150000,eagerTimezoneModules:0,
        chunks:chunks.map(c=>({file:c.fileName,entry:c.isEntry,imports:c.imports,dynamicImports:c.dynamicImports,
          bytes:Buffer.byteLength(c.code),gzipBytes:gzipSync(c.code,{level:6}).length,
          containsTimezone:Object.keys(c.modules).some(isTimezone)})),
      }
      this.emitFile({type:'asset',fileName:'bundle-report.json',source:JSON.stringify(report,null,2)+'\n'})
      this.emitFile({type:'asset',fileName:'THIRD-PARTY-NOTICES.txt',
        source:readFileSync(new URL('../domain/tcm/bazi/THIRD-PARTY-NOTICES.md',import.meta.url),'utf8')})
    },
  }
}
export default defineConfig({
  resolve:{dedupe:['lunar-typescript','timezonecomplete','tzdata']},
  plugins:[measureLazyBundle()],
  build:{
    outDir:'../../bazi-bundle',emptyOutDir:true,minify:true,
    lib:{entry:fileURLToPath(new URL('../domain/tcm/bazi/index.ts',import.meta.url)),formats:['es'],fileName:()=> 'bazi.mjs'},
    rollupOptions:{output:{chunkFileNames:'[name]-[hash].mjs',manualChunks(id) {
      if(id.includes('commonjsHelpers')) return 'shared'
      if(/node_modules[/\\](timezonecomplete|tzdata)[/\\]/.test(id)) return 'timezone'
      if(/node_modules[/\\]lunar-typescript[/\\]/.test(id)) return 'lunar'
    }}},
  },
})
