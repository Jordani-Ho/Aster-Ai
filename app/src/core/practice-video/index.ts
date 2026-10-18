import { finalizeEvent } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'

export const MAX_VIDEO_BYTES = 60 * 1024 * 1024
export const VIDEO_COLLECTION = 'practice-video-files'
export const VIDEO_INDEX_COLLECTION = 'practice-video-index'
interface VideoStorage {
  get(collection: string, key: string): Promise<unknown>
  put(collection: string, key: string, value: StoreValue): Promise<void>
  list(collection: string): Promise<{ key: string; value: unknown }[]>
  delete(collection: string, key: string): Promise<void>
}
async function findCipher(store: VideoStorage, hash: string) {
  const rows = await store.list(VIDEO_INDEX_COLLECTION)
  return rows.find(row => (row.value as { hash?: string })?.hash === hash)
}
export async function readVideoCipher(store: VideoStorage, hash: string) {
  const row = await findCipher(store, hash)
  return row ? store.get(VIDEO_COLLECTION, (row.value as { dataKey: string }).dataKey) : undefined
}
export async function writeVideoCipher(store: VideoStorage, hash: string, bytes: Uint8Array) {
  const prior = await findCipher(store, hash), dataKey = prior ? (prior.value as { dataKey: string }).dataKey : crypto.randomUUID()
  const indexKey = prior?.key ?? crypto.randomUUID()
  // Write the pointer first: after a crash, cleanup can still locate every byte record.
  await store.put(VIDEO_INDEX_COLLECTION, indexKey, { hash, dataKey })
  try { await store.put(VIDEO_COLLECTION, dataKey, bytes) }
  catch (error) { if (!prior) await store.delete(VIDEO_INDEX_COLLECTION, indexKey); throw error }
}
export async function deleteVideoCipher(store: VideoStorage, hash: string) {
  for (const row of await store.list(VIDEO_INDEX_COLLECTION)) if ((row.value as { hash?: string }).hash === hash) {
    await store.delete(VIDEO_COLLECTION, (row.value as { dataKey: string }).dataKey)
    await store.delete(VIDEO_INDEX_COLLECTION, row.key)
  }
}
export interface VideoContext { student: string; teacher: string; homework: string; role: 'original' | 'practice' }
export interface PracticeVideoRef {
  version: 1; sha256: string; bytes: number; key: string; iv: string
  plainSha256: string; mime: string; duration: number; context: VideoContext
}
type FileIdentity = Pick<Identity, 'privateKey' | 'publicKey'>
const hex = (value: Uint8Array) => [...value].map(x => x.toString(16).padStart(2, '0')).join('')
const unhex = (value: string) => new Uint8Array(value.match(/../g)!.map(x => parseInt(x, 16)))
const digest = async (value: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))))
const aad = (c: VideoContext) => new TextEncoder().encode(JSON.stringify(['aster-practice-video', 1, c.teacher, c.student, c.homework, c.role]))
function validContext(c: VideoContext) {
  return c && /^[0-9a-f]{64}$/.test(c.student) && /^[0-9a-f]{64}$/.test(c.teacher) &&
    typeof c.homework === 'string' && c.homework.length > 0 && c.homework.length <= 128 && ['original', 'practice'].includes(c.role)
}
export function validateVideoRef(input: unknown, context: VideoContext): asserts input is PracticeVideoRef {
  const r = input as PracticeVideoRef
  if (!r || r.version !== 1 || !validContext(context) || !validContext(r.context) || hex(aad(r.context)) !== hex(aad(context)) ||
      !/^[0-9a-f]{64}$/.test(r.sha256) || !/^[0-9a-f]{64}$/.test(r.plainSha256) ||
      !/^[0-9a-f]{64}$/.test(r.key) || !/^[0-9a-f]{24}$/.test(r.iv) ||
      !Number.isSafeInteger(r.bytes) || r.bytes < 17 || r.bytes > MAX_VIDEO_BYTES + 16 ||
      !Number.isFinite(r.duration) || r.duration <= 0 || r.duration > 180 ||
      !['video/mp4', 'video/quicktime', 'video/webm'].includes(r.mime)) throw Error('视频信息不匹配')
}
export async function encryptVideo(plain: Uint8Array, mime: string, duration: number, context: VideoContext) {
  if (plain.length > MAX_VIDEO_BYTES) throw Error('请剪短一点')
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw Error('单段不超过 3 分钟')
  if (!plain.length || !validContext(context) || !['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) throw Error('无法读取这段视频')
  const rawKey = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, key, new Uint8Array(plain)))
  const ref: PracticeVideoRef = { version: 1, sha256: await digest(bytes), bytes: bytes.length, key: hex(rawKey), iv: hex(iv), plainSha256: await digest(plain), mime, duration, context: { ...context } }
  rawKey.fill(0)
  return { ref, bytes }
}
export async function decryptVideo(bytes: Uint8Array, ref: PracticeVideoRef, context: VideoContext) {
  validateVideoRef(ref, context)
  if (bytes.length !== ref.bytes || await digest(bytes) !== ref.sha256) throw Error('视频校验失败，请重试')
  const raw = unhex(ref.key)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  raw.fill(0)
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(ref.iv), additionalData: aad(context) }, key, new Uint8Array(bytes)))
  if (await digest(plain) !== ref.plainSha256) throw Error('视频校验失败，请重试')
  return plain
}
function endpoint(base: string) {
  const url = new URL(base)
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/media' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw Error('视频服务地址不可用')
  return url.href.replace(/\/$/, '')
}
export function mediaAuthorization(base: string, identity: FileIdentity, action: 'get' | 'upload', hash: string) {
  const url = new URL(endpoint(base)), now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({ kind: 24242, created_at: now - 1, tags: [['t', action], ['x', hash], ['server', url.hostname], ['expiration', String(now + 60)]], content: action === 'upload' ? 'Upload encrypted practice video' : 'Download encrypted practice video' }, identity.privateKey)
  return 'Nostr ' + btoa(JSON.stringify(event)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
export async function uploadVideo(base: string, identity: FileIdentity, ref: PracticeVideoRef, bytes: Uint8Array, fetcher: typeof fetch = fetch) {
  validateVideoRef(ref, ref.context)
  if (bytes.length !== ref.bytes || await digest(bytes) !== ref.sha256) throw Error('视频校验失败，请重试')
  const response = await fetcher(endpoint(base) + '/upload', { method: 'PUT', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { authorization: mediaAuthorization(base, identity, 'upload', ref.sha256), 'content-type': 'application/octet-stream', 'x-sha-256': ref.sha256 }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw Error('视频上传未完成，请重试')
  const value = await response.json()
  if (value.sha256 !== ref.sha256 || value.size !== ref.bytes) throw Error('视频上传校验失败')
}
export async function downloadVideo(base: string, identity: FileIdentity, ref: PracticeVideoRef, context: VideoContext, fetcher: typeof fetch = fetch) {
  validateVideoRef(ref, context)
  const response = await fetcher(endpoint(base) + '/' + ref.sha256, { redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { authorization: mediaAuthorization(base, identity, 'get', ref.sha256) }, signal: AbortSignal.timeout(300000) })
  if (!response.ok || !response.body) throw Error('视频还在路上')
  const reader = response.body.getReader(), bytes = new Uint8Array(ref.bytes)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > bytes.length) throw Error('视频大小不匹配')
      bytes.set(value, offset); offset += value.length
    }
    if (offset !== ref.bytes) throw Error('视频还在路上')
    await decryptVideo(bytes, ref, context)
    return bytes
  } catch (error) { bytes.fill(0); await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}
const loading = new WeakMap<LocalStore, Map<string, Promise<Uint8Array>>>()
export async function loadVideo(store: LocalStore, base: string, identity: FileIdentity, ref: PracticeVideoRef, context: VideoContext) {
  validateVideoRef(ref, context)
  let tasks = loading.get(store)
  if (!tasks) { tasks = new Map(); loading.set(store, tasks) }
  let task = tasks.get(ref.sha256)
  if (!task) {
    task = (async () => {
      const local = await readVideoCipher(store, ref.sha256)
      if (local instanceof Uint8Array) {
        try { const plain = await decryptVideo(local, ref, context); plain.fill(0); return local }
        catch { await deleteVideoCipher(store, ref.sha256) }
      }
      const bytes = await downloadVideo(base, identity, ref, context)
      await writeVideoCipher(store, ref.sha256, bytes)
      return bytes
    })()
    tasks.set(ref.sha256, task)
  }
  try { return await decryptVideo(await task, ref, context) }
  finally { if (tasks.get(ref.sha256) === task) tasks.delete(ref.sha256) }
}
