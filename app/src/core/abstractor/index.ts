import prompt from '../../../../prompts/student/abstract-tongue.md?raw'
import table from '../../../../domain/tcm/tongue-features.json'
import { parseTongueReading, TONGUE_RETAKE, type TongueReading } from '../../../../domain/tcm/tongue'
import { VisionUnsupported, type VisionClient, type VisionMessage } from '../llm/vision'

// 只做“读图 → 特征 + 舌头框 + 偏色标记”，不保存、不裁剪、不清原图。
// 原图字节由调用方（core/tongue 的 captureTongue）在裁剪完成后当场清零。
export interface TransientPhoto { bytes: Uint8Array | null; type: string }
export interface AbstractContext { shichen: string; jieqi: string; city: string }

const RETAKE = '这次没看清，请重新拍一张'

function imageData(bytes: Uint8Array, type: string): string {
  const valid = type === 'image/png' ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216
      : type === 'image/webp' ? String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
        : false
  if (!valid || !bytes.length || bytes.length > 10 * 1024 * 1024) throw Error(RETAKE)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return 'data:' + type + ';base64,' + btoa(binary)
}

export async function readTongue(photo: TransientPhoto, context: AbstractContext, client: VisionClient): Promise<TongueReading> {
  const bytes = photo.bytes
  let messages: VisionMessage[] = []
  try {
    if (!(bytes instanceof Uint8Array)) throw Error(RETAKE)
    // 上下文只留在本机，不进模型输入；读外观不需要身份、诊断、时间或地点。
    for (const value of [context.shichen, context.jieqi, context.city]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[<>\r\n]|data:|https?:/i.test(value)) throw Error(RETAKE)
    }
    messages = [{ role: 'system', content: prompt + '\n' + JSON.stringify(table) }, { role: 'user', content: [{ type: 'image_url', image_url: { url: imageData(bytes, photo.type) } }] }]
    const reply = await client.describe(messages)
    let raw: unknown
    try { raw = JSON.parse(reply) } catch { throw Error(RETAKE) }
    try {
      return parseTongueReading(raw)
    } catch {
      // 找不到舌头、框太小或回复不是合格外观读取：一律按“没拍清舌头”请靠近重拍。
      throw Error(TONGUE_RETAKE)
    }
  } catch (error) {
    if (error instanceof VisionUnsupported) throw error
    if (error instanceof Error && (error.message === RETAKE || error.message === TONGUE_RETAKE)) throw error
    // 不把模型回复/请求文本（包括误回显的图片）带进界面或日志。
    throw Error(RETAKE)
  } finally {
    for (const message of messages) if (Array.isArray(message.content)) for (const part of message.content) part.image_url.url = ''
    messages.length = 0
  }
}
