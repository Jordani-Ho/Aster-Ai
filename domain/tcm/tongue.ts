import table from './tongue-features.json'

// V2-08 第一级舌象：只留舌头裁剪图 + 模型候选特征，老师说了算。
// 取值表（tongue-features.json）只管“看得见的外观”：uncertain 是“不确定”状态，
// 与“未见/无”分开；unknown 是 V2-03 旧记录的存量取值，读入后同样按“不确定”显示。
// 本模块只做纯数据与固定模板示意图，不读照片、不联网、不存字节。

export type TongueMark = (typeof table.teeth[number] | typeof table.cracks[number])[]
export type MarkValue = TongueMark | null | 'uncertain'

export interface TongueFeatures {
  color: keyof typeof table.color
  coatingColor: keyof typeof table.coatingColor
  coatingThickness: keyof typeof table.coatingThickness
  shape: keyof typeof table.shape
  teeth: MarkValue
  cracks: MarkValue
  confidence: number
}

export interface TongueCropRef { id: string; type: 'photo'; sha256: string; bytes: number }

export interface TongueAbstract {
  kind: 'tongue'
  features: TongueFeatures
  svg: string
  shichen: string
  jieqi: string
  city: string
  /** 拍摄光线偏色：界面在两张图共同标题下显示“颜色仅供参考”。 */
  lightingNote?: true
  /** 这次拍摄的舌头裁剪图引用；裁剪图走既有附件通道，不含原图。 */
  crop?: TongueCropRef
}

/** 模型返回的舌头外接框：相对坐标 0–1，左上角为原点。 */
export interface TongueBox { x: number; y: number; width: number; height: number }
export interface TongueReading { features: TongueFeatures; box: TongueBox; lightingNote: boolean }

export const TONGUE_RETAKE = '没拍清舌头，请靠近一点重拍。'
/** 框占画面不到 5% 视为没拍清：不生成记录，请靠近重拍。 */
export const TONGUE_BOX_MIN_RATIO = 0.05

export type FeatureKey = 'color' | 'coatingColor' | 'coatingThickness' | 'shape' | 'teeth' | 'cracks'
export const FEATURE_KEYS: FeatureKey[] = ['color', 'coatingColor', 'coatingThickness', 'shape', 'teeth', 'cracks']
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  color: '舌色', coatingColor: '苔色', coatingThickness: '苔厚', shape: '舌形', teeth: '齿痕', cracks: '裂纹',
}
export type MarkOption = 'none' | 'present' | 'uncertain'
export interface FeatureOption { value: string; label: string }

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

function isUncertain(value: unknown): boolean {
  return value === 'uncertain' || value === 'unknown'
}

function member(value: unknown, values: object): boolean {
  return typeof value === 'string' && Object.hasOwn(values, value)
}

function markText(value: MarkValue): string {
  if (value === 'uncertain') return '不确定'
  if (value === null) return '有，位置不确定'
  return value.length > 0 ? '有' : '未见'
}

function parseMarks(value: unknown, positions: readonly string[]): MarkValue {
  if (value === 'uncertain') return 'uncertain'
  if (value === null) return null
  if (!Array.isArray(value) || value.length > positions.length) throw Error('标记无效')
  if (value.some(item => typeof item !== 'string' || !positions.includes(item)) || new Set(value).size !== value.length) throw Error('标记无效')
  return positions.filter(item => value.includes(item))
}

export function parseTongueFeatures(value: unknown): TongueFeatures {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('特征无效')
  const v = value as Record<string, unknown>
  const keys = ['color', 'coatingColor', 'coatingThickness', 'shape', 'teeth', 'cracks', 'confidence']
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) throw Error('特征字段无效')
  if (!member(v.color, table.color) || !member(v.coatingColor, table.coatingColor)
    || !member(v.coatingThickness, table.coatingThickness) || !member(v.shape, table.shape)
    || typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)
    || v.confidence < table.confidence.min || v.confidence > table.confidence.max) throw Error('特征取值无效')
  return {
    color: v.color,
    coatingColor: v.coatingColor,
    coatingThickness: v.coatingThickness,
    shape: v.shape,
    teeth: parseMarks(v.teeth, table.teeth),
    cracks: parseMarks(v.cracks, table.cracks),
    confidence: v.confidence,
  } as TongueFeatures
}

// 裁剪框严格校验：相对坐标、在画面内、面积不少于 5%；不合格就按“没拍清舌头”提示重拍。
export function parseTongueBox(value: unknown): TongueBox {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(TONGUE_RETAKE)
  const box = value as Record<string, unknown>
  const keys = ['x', 'y', 'width', 'height']
  if (Object.keys(box).length !== keys.length) throw Error(TONGUE_RETAKE)
  const numbers: number[] = []
  for (const key of keys) {
    const item = box[key]
    if (typeof item !== 'number' || !Number.isFinite(item)) throw Error(TONGUE_RETAKE)
    numbers.push(item)
  }
  const [x, y, width, height] = numbers
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw Error(TONGUE_RETAKE)
  if (x + width > 1.001 || y + height > 1.001) throw Error(TONGUE_RETAKE)
  if (width * height < TONGUE_BOX_MIN_RATIO) throw Error(TONGUE_RETAKE)
  return { x, y, width, height }
}

// 模型回复：特征 + 舌头框 + 偏色标记。模型直接说找不到舌头时同样请靠近重拍。
export function parseTongueReading(value: unknown): TongueReading {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(TONGUE_RETAKE)
  const v = value as Record<string, unknown>
  if (v.error !== undefined || v.noTongue === true) throw Error(TONGUE_RETAKE)
  const { box, lightingNote, ...raw } = v
  const features = parseTongueFeatures(raw)
  return { features, box: parseTongueBox(box), lightingNote: lightingNote === true }
}

function isCropRef(value: unknown): value is TongueCropRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return typeof ref.id === 'string' && HEX32.test(ref.id) && ref.type === 'photo'
    && typeof ref.sha256 === 'string' && HEX64.test(ref.sha256)
    && Number.isSafeInteger(ref.bytes) && (ref.bytes as number) > 0
}

export function parseTongueAbstract(value: unknown): TongueAbstract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('舌象记录无效')
  const v = value as Record<string, unknown>
  const allowed = ['city', 'crop', 'features', 'jieqi', 'kind', 'lightingNote', 'shichen', 'svg']
  const required = ['city', 'features', 'jieqi', 'kind', 'shichen', 'svg']
  if (Object.keys(v).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(v, key)) || v.kind !== 'tongue') throw Error('舌象记录字段无效')
  for (const key of ['shichen', 'jieqi', 'city']) {
    if (typeof v[key] !== 'string' || !(v[key] as string).trim() || (v[key] as string).length > 80 || /[<>\r\n]|data:|https?:/i.test(v[key] as string)) throw Error('舌象时地无效')
  }
  if (v.lightingNote !== undefined && v.lightingNote !== true) throw Error('舌象光线标记无效')
  if (v.crop !== undefined && !isCropRef(v.crop)) throw Error('舌象裁剪图引用无效')
  const features = parseTongueFeatures(v.features)
  const svg = tongueSvg(features)
  if (v.svg !== svg) throw Error('舌象示意图无效')
  const record: TongueAbstract = {
    kind: 'tongue', features, svg,
    shichen: v.shichen as string, jieqi: v.jieqi as string, city: v.city as string,
  }
  if (v.lightingNote === true) record.lightingNote = true
  if (v.crop !== undefined) record.crop = { ...(v.crop as TongueCropRef) }
  return record
}

// 一行摘要，按方案示例：“舌色淡红 · 白苔、薄 · 齿痕不确定 · 裂纹未见”。
export function tongueSummary(features: TongueFeatures): string {
  const f = parseTongueFeatures(features)
  const parts = [
    `舌色${table.labels[f.color]}`,
    `${table.labels[f.coatingColor]}苔、${table.labels[f.coatingThickness]}`,
    `齿痕${markText(f.teeth)}`,
    `裂纹${markText(f.cracks)}`,
  ]
  if (isUncertain(f.shape)) parts.push('舌形不确定')
  return parts.join(' · ')
}

// 逐项文字（特征表一行一项）；“不确定”与“未见/无”分开写。
export function tongueFeatureText(features: TongueFeatures, key: FeatureKey): string {
  const f = parseTongueFeatures(features)
  if (key === 'teeth' || key === 'cracks') return markText(f[key])
  return table.labels[f[key]]
}

// 老师可选项：颜色类只列真实类别 + 不确定；齿痕/裂纹分“未见／有（位置不确定）／不确定”。
export function tongueFeatureOptions(key: FeatureKey): FeatureOption[] {
  if (key === 'teeth' || key === 'cracks') {
    return [{ value: 'none', label: '未见' }, { value: 'present', label: '有（位置不确定）' }, { value: 'uncertain', label: '不确定' }]
  }
  const values: Record<Exclude<FeatureKey, 'teeth' | 'cracks'>, object> = {
    color: table.color, coatingColor: table.coatingColor, coatingThickness: table.coatingThickness, shape: table.shape,
  }
  return Object.keys(values[key]).filter(value => value !== 'unknown').map(value => ({ value, label: table.labels[value as keyof typeof table.labels] }))
}

export function tongueFeatureValue(features: TongueFeatures, key: FeatureKey): string {
  const f = parseTongueFeatures(features)
  if (key === 'teeth' || key === 'cracks') {
    const value = f[key]
    if (value === 'uncertain') return 'uncertain'
    if (value === null) return 'present'
    return value.length > 0 ? 'present' : 'none'
  }
  const raw = String(f[key])
  // V2-03 旧记录里的 unknown 在下拉框里按“不确定”显示，老师一改就写成新取值。
  return raw === 'unknown' ? 'uncertain' : raw
}

// 改一项：返回新特征。颜色类直接换取值；齿痕/裂纹只改状态，不编造位置。
export function setTongueFeature(features: TongueFeatures, key: FeatureKey, value: string): TongueFeatures {
  const f = parseTongueFeatures(features)
  if (key === 'teeth' || key === 'cracks') {
    if (value !== 'none' && value !== 'present' && value !== 'uncertain') throw Error('标记取值无效')
    const next = value === 'uncertain' ? 'uncertain' as const : value === 'none' ? [] : null
    if (value === 'present' && Array.isArray(f[key]) && f[key].length > 0) return f
    return { ...f, [key]: next }
  }
  if (!tongueFeatureOptions(key).some(option => option.value === value)) throw Error('特征取值无效')
  return { ...f, [key]: value } as TongueFeatures
}

// 老师改值后示意图跟着变，裁剪图与偏色提示不变。
export function withTongueFeature(record: TongueAbstract, key: FeatureKey, value: string): TongueAbstract {
  const parsed = parseTongueAbstract(record)
  const features = setTongueFeature(parsed.features, key, value)
  return { ...parsed, features, svg: tongueSvg(features) }
}

/** 拍摄有偏色标记时，学生端和老师端都在两张图共同标题下显示“颜色仅供参考”。 */
export function tongueColorNote(record: Pick<TongueAbstract, 'lightingNote'>): string | null {
  return record.lightingNote === true ? '颜色仅供参考' : null
}

/** 偏色时舌色、苔色两行带“待核对”；老师改值后提示不消失。 */
export function tongueNeedsCheck(record: Pick<TongueAbstract, 'lightingNote'>, key: FeatureKey): boolean {
  return record.lightingNote === true && (key === 'color' || key === 'coatingColor')
}

/** 裁剪图不在时按原因分别说明，不借用最新照片拼一对。 */
export type TongueCropState = 'ok' | 'replaced' | 'expired' | 'missing' | 'failed'
export function tongueCropNotice(state: TongueCropState): string | null {
  switch (state) {
    case 'ok': return null
    case 'replaced': return '这次的裁剪图已被新图替换'
    case 'expired': return '裁剪图已过保留期限删除'
    case 'missing': return '还没收到裁剪图'
    case 'failed': return '裁剪图没能打开，可以再试一次'
  }
}

// 指纹差异用短文字：“有”“未见”“不确定”，例：齿痕：模型不确定→老师有。
function markDiffText(value: MarkValue): string {
  if (value === 'uncertain') return '不确定'
  if (value === null) return '有'
  return value.length > 0 ? '有' : '未见'
}

function featureShortText(features: TongueFeatures, key: FeatureKey): string {
  if (key === 'teeth' || key === 'cracks') return markDiffText(features[key])
  return table.labels[features[key]]
}

// 行内“模型：不确定 → 老师：有”用短文字（位置是否确定放在特征值那一列里）。
export function tongueFeatureShortText(features: TongueFeatures, key: FeatureKey): string {
  return featureShortText(parseTongueFeatures(features), key)
}

// 模型原值 → 老师定值的差异：只记账“特征项：模型说 X，老师定 Y”，不存图、不存身份。
export function tongueDiff(candidate: TongueAbstract, final: TongueAbstract): string[] {
  const before = parseTongueAbstract(candidate).features
  const after = parseTongueAbstract(final).features
  const diffs: string[] = []
  for (const key of FEATURE_KEYS) {
    const left = featureShortText(before, key)
    const right = featureShortText(after, key)
    if (left !== right) diffs.push(`${FEATURE_LABELS[key]}：模型${left}→老师${right}`)
  }
  return diffs
}

// 固定模板：所有路径和调色来自代码/取值表，绝不使用模型 SVG、照片像素或任意字符串。
export function tongueSvg(input: unknown): string {
  const f = parseTongueFeatures(input)
  const teeth: Record<string, [number, number]> = { 'left-back': [48, 85], 'left-middle': [44, 120], 'left-tip': [56, 155], 'right-back': [152, 85], 'right-middle': [156, 120], 'right-tip': [144, 155] }
  const cracks: Record<string, string> = { back: 'M100 62l-4 14 6 8', center: 'M100 95l-6 15 8 13-3 13', tip: 'M99 147l5 12-5 15', left: 'M72 104l8 13-7 14', right: 'M127 104l-8 13 7 14' }
  const marks = (Array.isArray(f.teeth) ? f.teeth : []).map(key => { const [x, y] = teeth[key]; return '<ellipse cx="' + x + '" cy="' + y + '" rx="6" ry="10" fill="#fffaf3"/>' }).join('')
  const lines = (Array.isArray(f.cracks) ? f.cracks : []).map(key => '<path d="' + cracks[key] + '" fill="none" stroke="#783b46" stroke-width="2"/>').join('')
  // “不确定”的苔：只用虚线围出通用位置、不填实色（V2-08 方案）；V2-03 的 unknown 旧值保持原来的画法。
  const uncertainCoating = f.coatingColor === 'uncertain' || f.coatingThickness === 'uncertain'
  const coating = uncertainCoating
    ? '<path d="M66 51Q100 39 134 51C145 77 148 109 136 146Q120 178 100 186Q80 178 64 146C52 109 55 77 66 51Z" fill="none" stroke="#9a9a9a" stroke-width="1.5" stroke-dasharray="4 4"/>'
    : '<path d="M66 51Q100 39 134 51C145 77 148 109 136 146Q120 178 100 186Q80 178 64 146C52 109 55 77 66 51Z" fill="' + table.coatingColor[f.coatingColor] + '" opacity="' + table.coatingThickness[f.coatingThickness] + '"/>'
  const uncertain = [f.color, f.coatingColor, f.coatingThickness, f.shape].some(isUncertain) || f.teeth === 'uncertain' || f.cracks === 'uncertain'
  const legacyUnknown = [f.color, f.coatingColor, f.coatingThickness, f.shape].some(value => value === 'unknown') || f.teeth === null || f.cracks === null
  const note = uncertain ? '（部分待定）' : legacyUnknown ? '（部分未知）' : ''
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" role="img" aria-label="抽象舌形示意图"><title>外观示意' + note + '</title><rect width="200" height="240" fill="#fffaf3"/><g transform="translate(100 0) scale(' + table.shape[f.shape] + ' 1) translate(-100 0)"><path d="M58 40Q100 24 142 40C160 60 165 110 150 156Q132 202 100 211Q68 202 50 156C35 110 40 60 58 40Z" fill="' + table.color[f.color] + '" stroke="#805760" stroke-width="2"/>' + coating + marks + lines + '</g></svg>'
}
