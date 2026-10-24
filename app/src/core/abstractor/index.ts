import prompt from '../../../../prompts/student/abstract-tongue.md?raw'
import table from '../../../../domain/tcm/tongue-features.json'
import { parseTongueReading, type TongueReading } from '../../../../domain/tcm/tongue'
import { VisionHttpError, VisionUnsupported, type VisionClient, type VisionMessage } from '../llm/vision'
import { isTongueFailure, tongueFailure, type TongueFailure } from '../tongue/failures'

// 只做“读图 → 特征 + 舌头框 + 偏色标记”，不保存、不裁剪、不清原图。
// 原图字节由调用方（core/tongue 的 captureTongue）在裁剪完成后当场清零。
export interface TransientPhoto { bytes: Uint8Array | null; type: string }
export interface AbstractContext { shichen: string; jieqi: string; city: string }

function imageData(bytes: Uint8Array, type: string): string {
  const valid = type === 'image/png' ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216
      : type === 'image/webp' ? String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
        : false
  if (!valid || !bytes.length || bytes.length > 10 * 1024 * 1024) throw tongueFailure('photo_format')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return 'data:' + type + ';base64,' + btoa(binary)
}

// V2-20：模型常把 JSON 包进 ```json 围栏或前后加一句说明。
// 先取第一个 { 到最后一个 } 再解析；解不出来按“模型暂时连不上”处理，不重试。
export function extractTongueJson(reply: string): unknown {
  const text = typeof reply === 'string' ? reply.trim().replace(/^\uFEFF/, '') : ''
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw tongueFailure('model_unavailable')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw tongueFailure('model_unavailable')
  }
}

// 视觉客户端的错误 → 四档失败（另加“模型不支持看图”）：账户问题不再重试，5xx/网络/超时值得再试一次。
export function classifyVisionFailure(error: unknown): TongueFailure {
  if (isTongueFailure(error)) return error
  if (error instanceof VisionUnsupported) return tongueFailure('model_unsupported')
  if (error instanceof VisionHttpError) {
    const status = error.status
    if (status === 401 || status === 402 || status === 403 || status === 429) return tongueFailure('model_account')
    if (status >= 500) return tongueFailure('model_unavailable', undefined, true)
    return tongueFailure('model_unavailable')
  }
  if (error instanceof TypeError) return tongueFailure('model_unavailable', undefined, true)
  if (typeof DOMException !== 'undefined' && error instanceof DOMException
    && (error.name === 'TimeoutError' || error.name === 'AbortError')) return tongueFailure('model_unavailable', undefined, true)
  return tongueFailure('model_unavailable')
}

export async function readTongue(photo: TransientPhoto, context: AbstractContext, client: VisionClient): Promise<TongueReading> {
  const bytes = photo.bytes
  let messages: VisionMessage[] = []
  try {
    if (!(bytes instanceof Uint8Array)) throw tongueFailure('photo_format')
    // 上下文只留在本机，不进模型输入；读外观不需要身份、诊断、时间或地点。
    for (const value of [context.shichen, context.jieqi, context.city]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[<>\r\n]|data:|https?:/i.test(value)) throw tongueFailure('model_unavailable')
    }
    messages = [{ role: 'system', content: prompt + '\n' + JSON.stringify(table) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: imageData(bytes, photo.type) } }] }]
    let reply: string
    try {
      reply = await client.describe(messages)
    } catch (error) {
      throw classifyVisionFailure(error)
    }
    const raw = extractTongueJson(reply)
    try {
      return parseTongueReading(raw)
    } catch {
      // 回复能解析、但找不到舌头或特征/框不合格：按“没拍到舌头”请靠近重拍。
      throw tongueFailure('no_tongue')
    }
  } finally {
    for (const message of messages) if (Array.isArray(message.content)) for (const part of message.content) part.image_url.url = ''
    messages.length = 0
  }
}
