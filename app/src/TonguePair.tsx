import { useEffect, useRef, useState } from 'react'
import {
  FEATURE_KEYS, FEATURE_LABELS, tongueColorNote, tongueCropNotice, tongueFeatureOptions,
  tongueFeatureShortText, tongueFeatureText, tongueFeatureValue, tongueNeedsCheck,
  tongueSummary, withTongueFeature, type FeatureKey, type TongueAbstract, type TongueCropState,
} from '../../domain/tcm/tongue'

// 固定图例，按方案原话；形状用法固定：实线/实色是候选，虚线是待定区域，灰底是颜色未定。
const LEGEND = '实线／实色：候选特征；虚线：待定区域；灰底：颜色未定。'

export interface TonguePairProps {
  record: TongueAbstract
  /** 直接给裁剪图字节（镜子用）。 */
  crop?: Uint8Array | null
  /** 或者按需读取（老师端 attachments、学生端 intake-attachments）。 */
  loadCrop?: () => Promise<Uint8Array | null>
  /** 裁剪图不在时的原因；loadCrop 返回空时用 missingCropState。 */
  cropState?: TongueCropState
  missingCropState?: TongueCropState
  /** V2-08 第 5 条：老师可逐项改值；候选原值用于显示“模型：不确定 → 老师：有”。 */
  candidate?: TongueAbstract
  editable?: boolean
  onChange?: (record: TongueAbstract) => void
  /** 学生镜子页写明“仅供自己对照”。 */
  studentNote?: boolean
  title?: string
}

export function TonguePair({
  record, crop, loadCrop, cropState = 'ok', missingCropState = 'expired',
  candidate, editable = false, onChange, studentNote = false, title,
}: TonguePairProps) {
  const [loaded, setLoaded] = useState<Uint8Array | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // 放大后窄屏可切换两图；默认并排。
  const [focus, setFocus] = useState<'both' | 'crop' | 'figure'>('both')

  const loadRef = useRef(loadCrop)
  loadRef.current = loadCrop
  useEffect(() => {
    let active = true
    setFailed(false)
    if (crop) { setLoaded(crop); return () => { active = false } }
    const load = loadRef.current
    if (!load) { setLoaded(null); return () => { active = false } }
    setLoading(true)
    void load().then(data => { if (active) setLoaded(data instanceof Uint8Array && data.length > 0 ? data : null) })
      .catch(() => { if (active) setLoaded(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // 只按这次拍摄的裁剪图引用重新读取；老师改特征不改裁剪图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, record.crop?.id])

  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!loaded || loaded.length === 0) { setUrl(''); return }
    const objectUrl = URL.createObjectURL(new Blob([loaded.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [loaded])

  const state: TongueCropState = cropState !== 'ok'
    ? cropState
    : failed ? 'failed' : loaded ? 'ok' : loading ? 'ok' : missingCropState
  const notice = tongueCropNotice(state)
  const colorNote = tongueColorNote(record)
  const summary = tongueSummary(record.features)

  return <section className={expanded ? 'tongue-pair expanded' : 'tongue-pair'} aria-label="舌象对照">
    {title && <p className="tongue-title">{title}</p>}
    {colorNote && <p className="tongue-alert" role="status">{colorNote}</p>}
    {expanded && <div className="tongue-switch" role="group" aria-label="放大对照切换">
      <button type="button" aria-pressed={focus === 'both'} onClick={() => setFocus('both')}>并排看</button>
      <button type="button" aria-pressed={focus === 'crop'} onClick={() => setFocus('crop')}>只看裁剪图</button>
      <button type="button" aria-pressed={focus === 'figure'} onClick={() => setFocus('figure')}>只看示意图</button>
    </div>}
    <div className="tongue-frames" style={focus === 'both' ? undefined : { gridTemplateColumns: '1fr' }}>
      {focus !== 'figure' && <figure className="tongue-frame">
        <div className="tongue-frame-box">
          {state === 'ok' && url
            ? <img src={url} alt="舌头裁剪图" onError={() => setFailed(true)} />
            : state === 'ok' && loading
              ? <p className="tongue-frame-missing">正在读取裁剪图…</p>
              : <p className="tongue-frame-missing">{notice ?? '裁剪图暂不可用'}</p>}
        </div>
        <figcaption>舌头裁剪图</figcaption>
      </figure>}
      {focus !== 'crop' && <figure className="tongue-frame">
        <div className="tongue-frame-box tongue-figure" dangerouslySetInnerHTML={{ __html: record.svg }} />
        <figcaption>示意图 · 模型候选</figcaption>
      </figure>}
    </div>
    <p className="tongue-legend">{LEGEND}</p>
    <button type="button" className="tongue-expand" onClick={() => setExpanded(value => !value)}>{expanded ? '收起对照' : '放大对照'}</button>
    <p className="tongue-summary">{summary}</p>
    {editable
      ? <div className="tongue-rows" role="group" aria-label="逐项修改舌象特征">
        {FEATURE_KEYS.map(key => <TongueRow key={key} record={record} candidate={candidate} featureKey={key} editable onChange={onChange} />)}
      </div>
      : <details className="tongue-details"><summary>逐项看</summary>
        <ul className="tongue-rows">
          {FEATURE_KEYS.map(key => <TongueRow key={key} record={record} featureKey={key} />)}
        </ul>
      </details>}
    {studentNote && <p className="tongue-note">仅供自己对照</p>}
  </section>
}

function TongueRow({ record, candidate, featureKey, editable, onChange }: {
  record: TongueAbstract
  candidate?: TongueAbstract
  featureKey: FeatureKey
  editable?: boolean
  onChange?: (record: TongueAbstract) => void
}) {
  const value = tongueFeatureText(record.features, featureKey)
  const changed = candidate ? tongueFeatureShortText(candidate.features, featureKey) !== tongueFeatureShortText(record.features, featureKey) : false
  const pending = tongueNeedsCheck(record, featureKey)
  return <div className="tongue-row">
    <span className="tongue-row-label">{FEATURE_LABELS[featureKey]}</span>
    {editable
      ? <select aria-label={'修改' + FEATURE_LABELS[featureKey]} value={tongueFeatureValue(record.features, featureKey)}
          onChange={event => onChange?.(withTongueFeature(record, featureKey, event.target.value))}>
          {tongueFeatureOptions(featureKey).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      : <span className="tongue-row-value">{value}</span>}
    {pending && <span className="tongue-row-pending">待核对</span>}
    {changed && candidate && <span className="tongue-row-diff">模型：{tongueFeatureShortText(candidate.features, featureKey)} → 老师：{tongueFeatureShortText(record.features, featureKey)}</span>}
  </div>
}
