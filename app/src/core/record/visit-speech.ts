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

export function createVisitSpeech(factory: (() => RecognitionPort) | null, callbacks: { onFinal: (text: string) => void; onError: (error: string) => void; onEnd?: () => void }): VisitSpeech {
  let current: RecognitionPort | null = null, running = false, stopping = false, seen = new Set<number>(), networkErrors = 0
  return {
    start(language) {
      if (language !== 'zh-CN' && language !== 'yue-Hant-HK') throw Error('识别语言无效')
      if (current) throw Error('语音识别正在结束')
      if (!factory) { callbacks.onError('unsupported'); return }
      try {
        const recognition = factory()
        current = recognition; running = true; stopping = false; networkErrors = 0; seen = new Set()
        recognition.lang = language; recognition.continuous = true; recognition.interimResults = true
        recognition.onresult = event => {
          if (current !== recognition) return
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i]
            if (result?.isFinal && !seen.has(i)) {
              seen.add(i)
              networkErrors = 0
              if (typeof result[0]?.transcript === 'string' && result[0].transcript.trim()) callbacks.onFinal(result[0].transcript)
            }
          }
        }
        recognition.onerror = event => {
          if (current !== recognition || !running) return
          if (event.error === 'no-speech' || event.error === 'aborted') return
          if (event.error === 'network' && ++networkErrors <= 3) return
          running = false; callbacks.onError(event.error)
        }
        recognition.onend = () => {
          if (current !== recognition) return
          if (!running) { current = null; callbacks.onEnd?.(); return }
          seen = new Set()
          try { recognition.start() } catch { running = false; callbacks.onError('restart-failed') }
        }
        recognition.start()
      } catch { running = false; current = null; callbacks.onError('start-failed') }
    },
    stop() { const recognition = current; running = false; if (recognition && !stopping) { stopping = true; try { recognition.stop() } catch { current = null; callbacks.onEnd?.() } } },
  }
}
