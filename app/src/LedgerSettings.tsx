import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { startLedgerSync } from './core/ledger/runtime'
import { createLedgerSync, type LedgerView } from './core/ledger/sync'
import type { TransportOptions } from './core/transport'

const defaults = ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_COMMUNITY_RELAYS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const labels = { topup: '充值', gift: '赠送', charge: '扣费', refund: '退款' }
type LinkStatus = Parameters<NonNullable<TransportOptions['onStatus']>>[0]

// 账本设置：默认自己起一个 transport；M1-15a 之后 App 传入已有的同步控制器（同一个 transport），
// 避免同一份加密存储上同时跑两个账本控制器。
export function LedgerSettings({ identity, store, ledger, managed = false, status: sharedStatus }: {
  identity: Identity
  store: LocalStore
  managed?: boolean
  ledger?: ReturnType<typeof createLedgerSync>
  status?: LinkStatus
}) {
  const [books, setBooks] = useState<LedgerView[]>([]), [error, setError] = useState('')
  const [role, setRole] = useState('student'), [peer, setPeer] = useState(''), [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<LinkStatus>(sharedStatus ?? 'offline')
  const runtimeRef = useRef<ReturnType<typeof createLedgerSync> | null>(null)
  useEffect(() => {
    setStatus(sharedStatus ?? 'offline')
  }, [sharedStatus])
  useEffect(() => {
    let disposed = false, pausing = false, runtime: ReturnType<typeof createLedgerSync> | undefined
    let started: ReturnType<typeof startLedgerSync> | undefined
    const refresh = async () => {
      if (!runtime || disposed || pausing) return
      const refs = await runtime.books()
      const views = await Promise.all(refs.map(ref => runtime!.view(ref.teacher, ref.student)))
      if (!disposed) setBooks(views)
    }
    const fail = () => { if (!disposed) setError('账本同步暂未成功，请检查中继设置或稍后重试。') }
    void (async () => {
      if (ledger) {
        runtime = ledger
        runtimeRef.current = runtime
        await refresh()
        return
      }
      if (managed) return
      const config = (await store.list('backup-config'))[0]?.value as { relays?: unknown } | undefined
      const relays = Array.isArray(config?.relays) && config.relays.every(s => typeof s === 'string') ? config.relays as string[] : defaults
      if (disposed || pausing) return
      if (!relays.length) { setError('请先在备份状态中配置社区中继，再打开账本同步。'); return }
      started = startLedgerSync({ identity, store, relays, onChange: () => { void refresh().catch(fail) }, onError: fail, onStatus: value => {
        if (!disposed) { setStatus(value); if (value === 'ready') setError('') }
      } })
      runtime = started.sync
      runtimeRef.current = runtime
      await refresh()
    })().catch(fail)
    const reload = () => { setError(''); setRevision(value => value + 1) }
    const pause = (event: globalThis.Event) => {
      pausing = true; runtimeRef.current = null
      if (started) (event as CustomEvent<{ pending: Promise<void>[] }>).detail.pending.push(started.close())
    }
    window.addEventListener('aster:store-restoring', pause)
    window.addEventListener('aster:relays-changed', reload)
    window.addEventListener('aster:store-restored', reload)
    return () => {
      disposed = true
      if (started) started.close()
      runtimeRef.current = null
      window.removeEventListener('aster:store-restoring', pause)
      window.removeEventListener('aster:relays-changed', reload); window.removeEventListener('aster:store-restored', reload)
    }
  }, [identity, store, revision, ledger, managed])
  const run = async (action: (runtime: ReturnType<typeof createLedgerSync>) => Promise<unknown>) => {
    setError('')
    try {
      if (!runtimeRef.current) throw Error('账本同步尚未就绪，请检查社区中继设置。')
      await action(runtimeRef.current)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '账本同步失败，请重试') }
  }
  return <details><summary>康币账本与对账</summary>
    <p role="status">{status === 'ready' ? '已连接社区中继' : status === 'connecting' ? '正在连接社区中继' : status === 'rejected' ? '中继拒绝连接，请核对成员资格' : '等待连接社区中继'}</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => {
      event.preventDefault()
      void run(async runtime => {
        await runtime.open(role === 'teacher' ? identity.publicKey : peer.trim(), role === 'student' ? identity.publicKey : peer.trim())
        setPeer('')
        await runtime.requestSync()
        setRevision(value => value + 1)
      })
    }}>
      <label>我在这本账中是<select value={role} onChange={e => setRole(e.target.value)}><option value="student">学生</option><option value="teacher">老师</option></select></label>
      <label>对方公钥（十六进制）<input value={peer} onChange={e => setPeer(e.target.value)} autoCapitalize="none" autoComplete="off" style={{ width: '100%', boxSizing: 'border-box' }} /></label>
      <p>师生双方需各自登记同一本账的公钥。</p>
      <button disabled={!peer.trim()}>登记账本</button>{' '}<button type="button" onClick={() => void run(runtime => runtime.requestSync())}>立即对账</button>
    </form>
    {!books.length && <p>尚未登记账本。</p>}
    {books.map(book => <section key={book.ledger.teacher + book.ledger.student}>
      <p style={{ overflowWrap: 'anywhere' }}>对方：{identity.publicKey === book.ledger.teacher ? book.ledger.student : book.ledger.teacher}</p>
      {book.code !== null && <p>余额：{book.balance} 康币 · 对账码：{book.code}</p>}
      {book.code === null && <p role="alert">{book.conflict ? '账本有冲突，请与老师核对' : '本机账本校验失败，请与对方核对'}</p>}
      {book.notices.map(text => <p role="status" key={text}>{text}</p>)}
      <ol>{book.ledger.events.map(event => {
        try {
          const fields = JSON.parse(event.content) as { type: keyof typeof labels; amount: number; at: string }
          return <li key={event.id}>{fields.at} · {labels[fields.type]} {fields.amount}</li>
        } catch { return <li key={event.id}>记录内容无效，请与对方核对</li> }
      })}</ol>
      {book.ledger.disputes.map(event => {
        try { return <p key={event.id}>异议：{(JSON.parse(event.content) as { memo: string }).memo} · {book.receipts.find(r => r.id === event.id)?.message ?? '已入异议列表'}</p> }
        catch { return <p key={event.id}>异议内容无效，请与对方核对</p> }
      })}
      {book.pendingDisputes.length > 0 && <p>有 {book.pendingDisputes.length} 条异议等待老师接收。</p>}
    </section>)}
  </details>
}
