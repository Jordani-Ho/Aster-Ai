export const INFO = 'aster/local-store/v1'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type StoreValue = JsonValue | Uint8Array
export interface EncryptedRecord { c: string; k: string; iv: string; ct: string; bin: boolean }
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
export const bytes = (input: Uint8Array) => new Uint8Array(input)
export const random = (length: number) => crypto.getRandomValues(new Uint8Array(length))
export function base64(input: Uint8Array): string {
  let binary = ''
  for (const byte of input) binary += String.fromCharCode(byte)
  return btoa(binary)
}
export function unbase64(input: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new Error('密文格式无效')
  const decoded = Uint8Array.from(atob(input), char => char.charCodeAt(0))
  if ((length !== undefined && decoded.length !== length) || base64(decoded) !== input) throw new Error('密文长度或编码无效')
  return decoded
}
export function validateAddress(collection: unknown, key: unknown): asserts collection is string {
  if (typeof collection !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(collection)) throw new Error('集合名必须是固定英文名')
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error('键名必须是 1 至 64 位随机 ID，不得包含个人信息')
}
export async function deriveKey(privateKey: Uint8Array, salt: string): Promise<CryptoKey> {
  if (privateKey.length !== 32) throw new Error('身份私钥长度错误')
  const source = await crypto.subtle.importKey('raw', bytes(privateKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unbase64(salt, 16), info: encoder.encode(INFO) }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('值必须为 JSON 或 Uint8Array')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) validateJson(value[i], ancestors)
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)) throw new Error('JSON 属性无效')
      validateJson((value as Record<string, unknown>)[key], ancestors)
    }
  }
  ancestors.delete(value)
}
function serialize(value: StoreValue): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    const result = new Uint8Array(value.length + 1); result[0] = 1; result.set(value, 1); return result
  }
  validateJson(value)
  const content = encoder.encode(JSON.stringify(value))
  const result = new Uint8Array(content.length + 1); result.set(content, 1); return result
}
export async function encryptRecord(key: CryptoKey, c: string, k: string, value: StoreValue): Promise<EncryptedRecord> {
  const plaintext = serialize(value); const iv = random(12)
  try {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${c}\u0000${k}`), tagLength: 128 }, key, plaintext)
    return { c, k, iv: base64(iv), ct: base64(new Uint8Array(ct)), bin: value instanceof Uint8Array }
  } finally { plaintext.fill(0) }
}
export function validateRecord(input: unknown): EncryptedRecord {
  if (!input || typeof input !== 'object') throw new Error('记录格式无效')
  const r = input as EncryptedRecord
  validateAddress(r.c, r.k)
  if (typeof r.bin !== 'boolean' || unbase64(r.ct).length < 17) throw new Error('记录格式无效')
  unbase64(r.iv, 12)
  return { c: r.c, k: r.k, iv: r.iv, ct: r.ct, bin: r.bin }
}
export async function decryptRecord(key: CryptoKey, input: unknown): Promise<StoreValue> {
  const record = validateRecord(input)
  let plaintext: Uint8Array<ArrayBuffer>
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(record.iv, 12), additionalData: encoder.encode(`${record.c}\u0000${record.k}`), tagLength: 128 }, key, unbase64(record.ct)))
  } catch { throw new Error('记录解密认证失败：密钥错误或数据已损坏') }
  try {
    if ((plaintext[0] === 1) !== record.bin) throw new Error('记录类型认证失败')
    if (plaintext[0] === 1) return plaintext.slice(1)
    if (plaintext[0] !== 0) throw new Error('记录类型版本未知')
    const value: unknown = JSON.parse(decoder.decode(plaintext.subarray(1)))
    validateJson(value); return value as JsonValue
  } finally { plaintext.fill(0) }
}
