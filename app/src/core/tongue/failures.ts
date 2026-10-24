import type { LocalStore, StoreValue } from '../store'

// V2-20：舌象失败分档。只记“属于哪一档”，不存照片、不存模型原文。
// 四档来自任务卡；模型不支持看图沿用原有提示，单独记一档，便于以后排查选错模型。
export type TongueFailureKind = 'photo_format' | 'no_tongue' | 'model_unavailable' | 'model_account' | 'model_unsupported'

export const TONGUE_FAILURE_MESSAGES: Record<TongueFailureKind, string> = {
  photo_format: '这张照片的格式手机浏览器打不开，请用相机直接拍，或在相机设置里选“兼容性最佳”。',
  no_tongue: '没拍到舌头，请靠近一点再拍',
  model_unavailable: '看舌象的模型暂时连不上，稍后再拍',
  model_account: '看舌象的模型账户需要检查（额度或密钥）',
  model_unsupported: '请换用支持看图的模型',
}

/** 拍到了舌头但太远：和“没拍到”同属一档，提示更具体。 */
export const TONGUE_TOO_FAR_MESSAGE = '离得有点远，请靠近一点再拍'

export class TongueFailure extends Error {
  constructor(
    public readonly kind: TongueFailureKind,
    message: string = TONGUE_FAILURE_MESSAGES[kind],
    /** 网络/超时/5xx 值得自动重试一次；格式、账户、框不对都不要再试。 */
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'TongueFailure'
  }
}

export function tongueFailure(kind: TongueFailureKind, message?: string, retryable = false): TongueFailure {
  return new TongueFailure(kind, message ?? TONGUE_FAILURE_MESSAGES[kind], retryable)
}

export function isTongueFailure(error: unknown): error is TongueFailure {
  return error instanceof TongueFailure
}

export function tongueFailureKind(error: unknown): TongueFailureKind | null {
  return isTongueFailure(error) ? error.kind : null
}

export const TONGUE_FAILURES = 'tongue-failures'
/** 只留最近 100 条，够排查用，不长期堆积。 */
export const TONGUE_FAILURE_MAX_ROWS = 100

export interface TongueFailureRow { id: string; at: string; kind: TongueFailureKind }

// 本机记录失败类别；不含照片、不含模型原文、不含学生身份。写失败不影响主流程。
export async function recordTongueFailure(store: LocalStore, kind: TongueFailureKind, at = new Date()): Promise<void> {
  const id = crypto.randomUUID()
  const row: TongueFailureRow = { id, at: at.toISOString(), kind }
  await store.put(TONGUE_FAILURES, id, row as unknown as StoreValue)
  const rows = await listTongueFailures(store)
  if (rows.length > TONGUE_FAILURE_MAX_ROWS) {
    for (const stale of rows.slice(0, rows.length - TONGUE_FAILURE_MAX_ROWS)) await store.delete(TONGUE_FAILURES, stale.id)
  }
}

export async function listTongueFailures(store: LocalStore): Promise<TongueFailureRow[]> {
  const rows: TongueFailureRow[] = []
  for (const row of await store.list(TONGUE_FAILURES)) {
    const value = row.value as Partial<TongueFailureRow> | undefined
    if (!value || value.id !== row.key || typeof value.at !== 'string' || typeof value.kind !== 'string') continue
    if (!(value.kind in TONGUE_FAILURE_MESSAGES)) continue
    rows.push({ id: value.id, at: value.at, kind: value.kind as TongueFailureKind })
  }
  return rows.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
}
