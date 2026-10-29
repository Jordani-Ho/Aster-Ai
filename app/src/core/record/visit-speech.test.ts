import { describe, expect, it } from 'vitest'
import { createVisitSpeech, type RecognitionPort } from './visit-speech'

class FakeRecognition implements RecognitionPort {
  lang = ''; continuous = false; interimResults = false; starts = 0; stops = 0
  onresult: RecognitionPort['onresult'] = null
  onend: RecognitionPort['onend'] = null
  onerror: RecognitionPort['onerror'] = null
  start() { this.starts++ }
  stop() { this.stops++ }
  result(index: number, text: string, isFinal = true) {
    const item = Object.assign([{ transcript: text }], { isFinal })
    this.onresult?.({ resultIndex: index, results: Object.assign([], { [index]: item, length: index + 1 }) })
  }
}
describe('面诊语音识别适配器', () => {
  it('静音结束自动重启，同一轮重复结果不重复，下一轮同句话仍保留', () => {
    const fake = new FakeRecognition(), lines: string[] = [], errors: string[] = []
    const tool = createVisitSpeech(() => fake, { onFinal: text => lines.push(text), onError: error => errors.push(error) })
    tool.start('zh-CN'); expect(fake.continuous).toBe(true); expect(fake.lang).toBe('zh-CN')
    fake.result(0, '合成问诊'); fake.result(0, '合成问诊'); fake.result(1, '合成片段', false)
    fake.onend?.(); expect(fake.starts).toBe(2); fake.result(0, '合成问诊')
    expect(lines).toEqual(['合成问诊', '合成问诊']); expect(errors).toEqual([])
    tool.stop(); fake.onend?.(); expect(fake.starts).toBe(2)
  })
  it('停止后识别器结束前仍接收最后一句定稿，结束后不再接收', () => {
    const fake = new FakeRecognition(), lines: string[] = []
    const tool = createVisitSpeech(() => fake, { onFinal: text => lines.push(text), onError: () => {} })
    tool.start('zh-CN'); tool.stop(); tool.stop(); expect(fake.stops).toBe(1); fake.result(0, '停止时最后一句'); fake.onend?.(); fake.result(1, '不应出现')
    expect(lines).toEqual(['停止时最后一句']); expect(fake.starts).toBe(1)
  })
  it('粤语选项传给识别器，识别失败不重启并报告给录音层', () => {
    const fake = new FakeRecognition(), errors: string[] = []
    const tool = createVisitSpeech(() => fake, { onFinal: () => {}, onError: error => errors.push(error) })
    tool.start('yue-Hant-HK'); expect(fake.lang).toBe('yue-Hant-HK')
    fake.onerror?.({ error: 'network' }); fake.onend?.()
    expect(errors).toEqual(['network']); expect(fake.starts).toBe(1)
  })
  it('拒绝不支持的语言，缺少识别器时通知上层', () => {
    const errors: string[] = [], tool = createVisitSpeech(null, { onFinal: () => {}, onError: error => errors.push(error) })
    expect(() => tool.start('bad' as never)).toThrow()
    tool.start('zh-CN'); expect(errors).toEqual(['unsupported'])
  })
})
