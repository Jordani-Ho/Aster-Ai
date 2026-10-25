import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { adjustHerb, createHerb, HERB_UNITS, listHerbLedger, listHerbs, loadHerbUnits, receiveHerb, saveHerbUnits, setHerbEnabled, toSmallestUnit, type Herb, type HerbLedger, type HerbUnit, type HerbUnits } from './core/herbs'
import './herbs.css'

export function HerbLibrary({ store, role }: { store: LocalStore; role: '老师' | '学生' }) {
  const [herbs, setHerbs] = useState<Herb[]>([])
  const [ledger, setLedger] = useState<HerbLedger[]>([])
  const [units, setUnits] = useState<HerbUnits>({ qianInTenthsGram: null, liangInTenthsGram: null })
  const [name, setName] = useState('')
  const [unit, setUnit] = useState<HerbUnit>('克')
  const [threshold, setThreshold] = useState('0')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [adjustments, setAdjustments] = useState<Record<string, string>>({})
  const [adjustReasons, setAdjustReasons] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => { const [rows, config, entries] = await Promise.all([listHerbs(store), loadHerbUnits(store), listHerbLedger(store)]); setHerbs(rows); setUnits(config); setLedger(entries) }
  useEffect(() => { void refresh().catch(() => setError('药材库暂时读不出来。')) }, [store])
  const save = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(''); setStatus('')
    try { await work(); await refresh(); window.dispatchEvent(new Event('aster:data-changed')); setStatus('已保存。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '没保存成功，请重试。') }
    finally { setBusy(false) }
  }
  const shown = (herb: Herb): string => {
    const divisor = herb.unit === '克' ? 10 : herb.unit === '钱' ? units.qianInTenthsGram : herb.unit === '两' ? units.liangInTenthsGram : 1
    return divisor ? String(herb.quantity / divisor) : '请先确认换算'
  }
  return <section aria-label="药材库" className="herb-library">
    <h2>药材库</h2>
    <p className="nl-quiet">库存只保存在这台设备上。每次入库和扣减都会留流水，不会硬删历史。</p>
    <form onSubmit={event => { event.preventDefault(); void save(async () => { await createHerb(store, { name, unit, threshold: Number(threshold) }, units); setName(''); setThreshold('0') }) }}>
      <label>药材名称<input value={name} maxLength={40} onChange={event => setName(event.target.value)} required /></label>
      <label>单位<select value={unit} onChange={event => setUnit(event.target.value as HerbUnit)}>{HERB_UNITS.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>警戒线（{unit}）<input type="number" min="0" step={['克', '钱', '两'].includes(unit) ? '0.1' : '1'} value={threshold} onChange={event => setThreshold(event.target.value)} required /></label>
      <button className="nl-primary" type="submit" disabled={busy}>添加药材</button>
    </form>
    <details className="nl-section"><summary>钱、两的克数换算</summary>
      <p className="nl-quiet">{role === '老师' ? '请确认本馆使用的换算；未确认前不能用钱、两录入。' : '按老师确认的馆内换算填写；未填写前不能用钱、两录入。'}</p>
      <label>1 钱 = 克<input type="number" min="0.1" step="0.1" value={units.qianInTenthsGram === null ? '' : units.qianInTenthsGram / 10} onChange={event => setUnits(current => ({ ...current, qianInTenthsGram: event.target.value === '' ? null : Number(event.target.value) * 10 }))} /></label>
      <label>1 两 = 克<input type="number" min="0.1" step="0.1" value={units.liangInTenthsGram === null ? '' : units.liangInTenthsGram / 10} onChange={event => setUnits(current => ({ ...current, liangInTenthsGram: event.target.value === '' ? null : Number(event.target.value) * 10 }))} /></label>
      <button type="button" onClick={() => void save(() => saveHerbUnits(store, units))} disabled={busy}>保存换算</button>
    </details>
    {herbs.length === 0 && <p>库里还没有药材。</p>}
    <ul className="herb-list">{herbs.map(herb => <li key={herb.id} className="nl-card">
      <div><strong>{herb.name}</strong><span> {herb.enabled ? shown(herb) : '已停用'} {herb.unit}</span><small>警戒线 {shown({ ...herb, quantity: herb.threshold })} {herb.unit}</small></div>
      <div className="herb-actions">
        {herb.enabled && <><label>入库数量<input aria-label={`${herb.name}入库数量`} type="number" min={herb.unit === '克' || herb.unit === '钱' || herb.unit === '两' ? '0.1' : '1'} step={herb.unit === '克' || herb.unit === '钱' || herb.unit === '两' ? '0.1' : '1'} value={amounts[herb.id] ?? ''} onChange={event => setAmounts(current => ({ ...current, [herb.id]: event.target.value }))} /></label>
          <button type="button" disabled={busy || !amounts[herb.id]} onClick={() => void save(async () => { await receiveHerb(store, herb.id, Number(amounts[herb.id]), units, '老师或学生手动入库', crypto.randomUUID().replaceAll('-', '')); setAmounts(current => ({ ...current, [herb.id]: '' })) })}>入库</button></>}
        {herb.enabled && <><label>盘点差额（可正可负）<input aria-label={`${herb.name}盘点差额`} type="number" step={herb.unit === '克' || herb.unit === '钱' || herb.unit === '两' ? '0.1' : '1'} value={adjustments[herb.id] ?? ''} onChange={event => setAdjustments(current => ({ ...current, [herb.id]: event.target.value }))} /></label>
          <label>调整原因<input aria-label={`${herb.name}调整原因`} value={adjustReasons[herb.id] ?? ''} onChange={event => setAdjustReasons(current => ({ ...current, [herb.id]: event.target.value }))} /></label>
          <button type="button" disabled={busy || !adjustments[herb.id] || !adjustReasons[herb.id]?.trim()} onClick={() => void save(async () => { const amount = Number(adjustments[herb.id]); const delta = toSmallestUnit(Math.abs(amount), herb.unit, units) * (amount < 0 ? -1 : 1); await adjustHerb(store, herb.id, delta, adjustReasons[herb.id], 'adjust-' + crypto.randomUUID().replaceAll('-', '')); setAdjustments(current => ({ ...current, [herb.id]: '' })); setAdjustReasons(current => ({ ...current, [herb.id]: '' })) })}>记盘点调整</button></>}
        <button type="button" disabled={busy} onClick={() => void save(() => setHerbEnabled(store, herb.id, !herb.enabled))}>{herb.enabled ? '停用' : '重新启用'}</button>
      </div>
    </li>)}</ul>
    <details className="nl-section"><summary>库存流水（{ledger.length}）</summary>
      {ledger.length === 0 ? <p>还没有出入库记录。</p> : <ul className="herb-ledger">{ledger.map(row => {
        const herb = herbs.find(item => item.id === row.herb)
        const divisor = herb?.unit === '克' ? 10 : herb?.unit === '钱' ? units.qianInTenthsGram : herb?.unit === '两' ? units.liangInTenthsGram : 1
        return <li key={row.id}><strong>{herb?.name ?? '已移除药材'} · {row.reason}</strong><span>{divisor ? (row.delta / divisor).toString() : row.delta} {herb?.unit ?? ''} · 余额 {divisor ? row.balanceAfter / divisor : row.balanceAfter}</span><small>{new Date(row.at).toLocaleString()} · {row.ref}</small></li>
      })}</ul>}
    </details>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </section>
}
