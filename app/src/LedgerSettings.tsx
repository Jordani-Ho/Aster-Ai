import {uiError} from './core/onboarding/ui'
import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { startLedgerSync } from './core/ledger/runtime'
import { createLedgerSync, type LedgerView } from './core/ledger/sync'
import { filterChargesByMember, SELF_MEMBER } from './core/ledger/filter'
import type { TransportOptions } from './core/transport'
import type { LlmClient } from './core/llm'
import { MoneyEntry } from './MoneyEntry'
import { formatMoney } from './core/ledger/money'
import { parseChainFields } from './core/ledger'

const defaults = ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_COMMUNITY_RELAYS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const labels = { topup: '充值', gift: '赠送', charge: '扣费', refund: '退款' }
type LinkStatus = Parameters<NonNullable<TransportOptions['onStatus']>>[0]

// 账本设置：默认自己起一个 transport；M1-15a 之后 App 传入已有的同步控制器（同一个 transport），
// 避免同一份加密存储上同时跑两个账本控制器。
export function LedgerSettings({ identity, store, ledger, managed = false, status: sharedStatus, members = [],llm=null }: {
  identity: Identity
  store: LocalStore
  managed?: boolean
  ledger?: ReturnType<typeof createLedgerSync>
  status?: LinkStatus
  members?: readonly { alias: string }[]
  llm?:LlmClient|null
}) {
  const [books, setBooks] = useState<LedgerView[]>([]), [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [memberFilter, setMemberFilter] = useState<string | null>(null)
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
      if (!relays.length) { setError('社区中继尚未配置，请联系部署者，再打开账本同步。'); return }
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
    const changed=()=>{void refresh().catch(fail)}
    window.addEventListener('aster:data-changed',changed)
    return () => {
      disposed = true
      if (started) started.close()
      runtimeRef.current = null
      window.removeEventListener('aster:store-restoring', pause)
      window.removeEventListener('aster:relays-changed', reload); window.removeEventListener('aster:store-restored', reload)
      window.removeEventListener('aster:data-changed',changed)
    }
  }, [identity, store, revision, ledger, managed])
  const run = async (action: (runtime: ReturnType<typeof createLedgerSync>) => Promise<unknown>) => {
    setError('')
    try {
      if (!runtimeRef.current) throw Error('账本同步尚未就绪，请检查社区中继设置。')
      await action(runtimeRef.current)
    } catch (cause) { setError(uiError(cause,'账本同步失败，请重试')) }
  }
  return <details><summary>钱账与对账</summary>
    <p role="status">{status === 'ready' ? '已连接社区中继' : status === 'connecting' ? '正在连接社区中继' : status === 'rejected' ? '中继拒绝连接，请核对成员资格' : '等待连接社区中继'}</p>
    {error && <p role="alert">{error}</p>}
    <p>打开老师邀请后会自动建立师生账本。</p><button type="button" onClick={()=>void run(runtime=>runtime.requestSync())}>立即对账</button>
    {!books.length && <p>尚未登记账本。</p>}
    {books.map(book => <section key={book.ledger.teacher + book.ledger.student}>
      <p style={{ overflowWrap: 'anywhere' }}>对方：{identity.publicKey === book.ledger.teacher ? '学生' : '老师'}</p>
      {book.code !== null && <p>钱账余额：{book.ledger.events.length?formatMoney(book.balance!,parseChainFields(book.ledger.events[0]).currency):'尚未记账'} · 对账码：{book.code}</p>}
      {identity.publicKey===book.ledger.teacher&&runtimeRef.current&&<MoneyEntry store={store} book={book.ledger} writer={runtimeRef.current} llm={llm} onConfirmed={()=>setRevision(v=>v+1)}/>}
      {book.code === null && <p role="alert">{book.conflict ? '账本有冲突，请与老师核对' : '本机账本校验失败，请与对方核对'}</p>}
      {book.notices.map(text => <p role="status" key={text}>{text}</p>)}
      {(() => {
        const aliases = [...new Set([
          ...members.map(member => member.alias),
          ...book.ledger.events.flatMap(event => {
            try {
              const fields = JSON.parse(event.content) as { type?: unknown; forMember?: unknown }
              return fields.type === 'charge' && typeof fields.forMember === 'string' ? [fields.forMember] : []
            } catch { return [] }
          }),
        ])]
        return <>
          {aliases.length > 0 && <label>按家人筛选<select value={memberFilter === null ? 'all' : memberFilter} onChange={event => setMemberFilter(event.target.value === 'all' ? null : event.target.value)}>
            <option value="all">全部</option><option value={SELF_MEMBER}>本人</option>
            {aliases.map(alias => <option key={alias} value={alias}>{alias}</option>)}
          </select></label>}
          <ol>{(memberFilter===null?book.ledger.events:filterChargesByMember(book.ledger, memberFilter)).map(event => {
            try {
              const fields = parseChainFields(event)
              return <li key={event.id}>{fields.at} · {labels[fields.type]} {formatMoney(fields.amount!,fields.currency)}{fields.forMember ? ' · ' + fields.forMember : ''}</li>
            } catch { return <li key={event.id}>记录内容无效，请与对方核对</li> }
          })}</ol>
        </>
      })()}
      {book.ledger.disputes.map(event => {
        try { return <p key={event.id}>异议：{(JSON.parse(event.content) as { memo: string }).memo} · {book.receipts.find(r => r.id === event.id)?.message ?? '已入异议列表'}</p> }
        catch { return <p key={event.id}>异议内容无效，请与对方核对</p> }
      })}
      {book.pendingDisputes.length > 0 && <p>有 {book.pendingDisputes.length} 条异议等待老师接收。</p>}
    </section>)}
  </details>
}
