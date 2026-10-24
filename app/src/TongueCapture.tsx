import { useRef, useState, useEffect } from 'react'
import type { LocalStore } from './core/store'
import { loadPersonalModel } from './core/llm/personal'
import { createVisionClient } from './core/llm/vision'
import { captureTongue } from './core/tongue'
import { isTongueFailure, recordTongueFailure } from './core/tongue/failures'
import { loadProfile } from './core/intake/session'
import { heavenNow } from './core/heaven'
import type { TongueAbstract } from '../../domain/tcm/tongue'
import './tongue.css'

// V2-08 拍照入口：一句普通说明放在按钮附近，不弹窗、不要求勾选；“怎么拍更清楚”可选展开。
// 处理只留舌头框内的裁剪图（长边 ≤512），原图在裁剪后当场清零，不写本机、不发中继。
// V2-20：送模型前先规范成 ≤1600 JPEG（去 EXIF）；失败按类别说清楚，本机只记失败类别。
// V2-28：舌象区不再选居住城市（城市来自基础信息；V2-23 落地前先读现有 profile.city 兜底）。
export function TongueCapture({ store, modelStore = store, onCaptured, disabled = false, onBusyChange, minimal = false }: {
  store: LocalStore
  modelStore?: LocalStore
  onCaptured: (record: TongueAbstract, at: Date, crop: Uint8Array) => Promise<void>
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  /** V2-16 学生首页“照镜子”只用一个大按钮，说明和帮助收起来。 */
  minimal?: boolean
}) {
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true), lock = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [city, setCity] = useState('')
  useEffect(() => { void loadProfile(store).then(profile => { if (mounted.current) setCity(profile.city.value ?? '') }).catch(() => {}) }, [store])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const capture = async (element: HTMLInputElement) => {
    let file: File | null = element.files?.[0] ?? null
    element.value = ''
    if (!file || lock.current || disabled) return
    lock.current = true; setBusy(true); onBusyChange?.(true); setError('')
    let bytes: Uint8Array | null = null
    try {
      const type = file.type
      bytes = new Uint8Array(await file.arrayBuffer()); file = null
      const [config, profile] = await Promise.all([loadPersonalModel(modelStore), loadProfile(store)])
      if (!config) throw Error('请先接入支持看图的模型')
      if (!profile.city.value) throw Error('请先填居住城市：在「我」→「我的时间」里选一下')
      const at = new Date(), time = await heavenNow(store, at)
      if (!time.city) throw Error('请先填居住城市：在「我」→「我的时间」里选一下')
      const context = { shichen: time.shichen, jieqi: time.jieqi, city: time.city }
      // captureTongue 在裁剪完成后清原图（含送模型前的临时副本）；失败时也会清。
      const { record, crop } = await captureTongue({ bytes, type }, context, createVisionClient(config))
      bytes = null
      if (mounted.current) await onCaptured(record, at, crop)
    } catch (cause) {
      // 只记失败类别，不存照片、不存模型原文；写失败不影响给用户看提示。
      if (isTongueFailure(cause)) void recordTongueFailure(store, cause.kind).catch(() => {})
      if (mounted.current) setError(cause instanceof Error ? cause.message : '未能读取，请重新拍摄')
    } finally {
      file = null; bytes?.fill(0); bytes = null; lock.current = false
      if (mounted.current) { setBusy(false); onBusyChange?.(false) }
    }
  }
  return <div>
    {minimal
      ? <p className="tongue-hint">自然光、关美颜、舌头放松伸出，手机离脸一拃左右。</p>
      : <><p className="tongue-hint">自然光、关美颜、舌头放松伸出，手机离脸一拃左右。</p>
        <details className="tongue-help"><summary>怎么拍更清楚</summary><p>让整条舌头在画面里，看清两侧和舌尖；不要开美颜，手机离脸一拃左右。</p></details></>}
    {!city && <p className="nl-quiet">还没填居住城市：请先在「我」→「我的时间」里选好，再来拍舌象。</p>}
    <input ref={input} type="file" aria-label="选择舌象照片" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" capture="environment" hidden onChange={event => void capture(event.currentTarget)} />
    <button className={minimal ? 'nl-primary' : undefined} disabled={disabled || busy || !city} onClick={() => input.current?.click()}>{busy ? '正在读取舌象…' : minimal ? '拍今天的舌象' : '拍舌象 / 重拍'}</button>
    {error && <p role="alert">{error}</p>}
  </div>
}
