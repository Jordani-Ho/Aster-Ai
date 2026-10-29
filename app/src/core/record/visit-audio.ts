import type { LocalStore, StoreValue } from '../store'
export const VISIT_AUDIO_INDEX = 'visit-audio-index'
export const VISIT_AUDIO_CHUNKS = 'visit-audio-chunks'
type AudioIndex = { segments: { id:string; mimeType:string; chunks:number }[] }
const keyPattern = /^[a-zA-Z0-9_-]{1,16}$/
function checkId(id:string) { if (!/^[0-9a-f]{32}$/.test(id)) throw Error('面诊编号无效') }
function checkSegment(id:string) { if (!keyPattern.test(id)) throw Error('录音编号无效') }
function index(value: unknown): AudioIndex {
  if (value === undefined) return { segments:[] }
  const raw = value as AudioIndex
  if (!raw || !Array.isArray(raw.segments) || raw.segments.some(s => !s || !keyPattern.test(s.id) || typeof s.mimeType !== 'string' || !Number.isSafeInteger(s.chunks) || s.chunks < 0)) throw Error('录音目录无效')
  return raw
}
export async function appendVisitAudioChunk(store:LocalStore, visit:string, segment:string, mimeType:string, data:Uint8Array):Promise<void> {
  checkId(visit); checkSegment(segment)
  if (!/^audio\/(webm|ogg|mp4)(;[a-zA-Z0-9=., _-]+)?$/.test(mimeType) || !(data instanceof Uint8Array) || !data.length) throw Error('录音格式或内容无效')
  await store.atomic(async tx => {
    const saved=index(await tx.get(VISIT_AUDIO_INDEX,visit)); let row=saved.segments.find(item=>item.id===segment)
    if (!row) { row={id:segment,mimeType,chunks:0}; saved.segments.push(row) }
    if (row.mimeType!==mimeType) throw Error('录音格式不一致')
    tx.put(VISIT_AUDIO_CHUNKS, `${visit}-${segment}-${row.chunks}`, data)
    row.chunks++; tx.put(VISIT_AUDIO_INDEX,visit,saved as unknown as StoreValue)
  })
}
export async function loadVisitAudio(store:LocalStore, visit:string, segment:string):Promise<{mimeType:string;data:Uint8Array}|null> {
  checkId(visit); checkSegment(segment)
  const row=index(await store.get(VISIT_AUDIO_INDEX,visit)).segments.find(item=>item.id===segment)
  if (!row) return null
  const chunks:Uint8Array[]=[]
  for (let i=0;i<row.chunks;i++) { const data=await store.get(VISIT_AUDIO_CHUNKS,`${visit}-${segment}-${i}`); if (!(data instanceof Uint8Array)) throw Error('录音片段缺失'); chunks.push(data) }
  const bytes=new Uint8Array(chunks.reduce((n,part)=>n+part.length,0)); let pos=0
  for (const part of chunks) { bytes.set(part,pos); pos+=part.length }
  return {mimeType:row.mimeType,data:bytes}
}
export async function clearVisitAudio(store:LocalStore,visit:string):Promise<void> {
  checkId(visit)
  await store.atomic(async tx=>{
    const saved=index(await tx.get(VISIT_AUDIO_INDEX,visit))
    for (const row of saved.segments) for (let i=0;i<row.chunks;i++) tx.delete(VISIT_AUDIO_CHUNKS,`${visit}-${row.id}-${i}`)
    tx.delete(VISIT_AUDIO_INDEX,visit)
  })
}

export async function listVisitAudioSegments(store:LocalStore,visit:string):Promise<{id:string;mimeType:string}[]> {
  checkId(visit)
  return index(await store.get(VISIT_AUDIO_INDEX,visit)).segments.map(({id,mimeType})=>({id,mimeType}))
}
