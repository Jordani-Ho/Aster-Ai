/** 可替换的面诊转文字接口；不管理录音，不在识别失败时停止录音。 */
export type VisitLanguage = 'zh-CN' | 'yue-Hant-HK'
export interface RecognitionPort {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  stop(): void
}
export interface VisitSpeech { start(language: VisitLanguage): void; stop(): void }

export function createVisitSpeech(factory: (() => RecognitionPort) | null, callbacks: { onFinal: (text: string) => void; onError: (error: string) => void }): VisitSpeech {
  let current: RecognitionPort | null = null, running = false, seen = new Set<number>()
  return {
    start(language) {
      if (language !== 'zh-CN' && language !== 'yue-Hant-HK') throw Error('识别语言无效')
      if (running) throw Error('语音识别已经开始')
      if (!factory) { callbacks.onError('unsupported'); return }
      try {
        const recognition = factory()
        current = recognition; running = true; seen = new Set()
        recognition.lang = language; recognition.continuous = true; recognition.interimResults = true
        recognition.onresult = event => {
          if (!running || current !== recognition) return
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i]
            if (result?.isFinal && !seen.has(i)) {
              seen.add(i)
              if (typeof result[0]?.transcript === 'string' && result[0].transcript.trim()) callbacks.onFinal(result[0].transcript)
            }
          }
        }
        recognition.onerror = event => { if (current === recognition && running) { running = false; callbacks.onError(event.error) } }
        recognition.onend = () => {
          if (!running || current !== recognition) return
          seen = new Set()
          try { recognition.start() } catch { running = false; callbacks.onError('restart-failed') }
        }
        recognition.start()
      } catch { running = false; current = null; callbacks.onError('start-failed') }
    },
    stop() { const recognition = current; running = false; current = null; if (recognition) { try { recognition.stop() } catch { /* 浏览器已停止 */ } } },
  }
}
