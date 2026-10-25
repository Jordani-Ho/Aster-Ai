import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { defaultSchedule, GROUNDWORK_ITEMS, groundworkStatus, saveGroundwork, type Groundwork, type Period } from './core/hall/groundwork'
import { loadTemplates, saveTemplateDraft, publishTemplate } from './core/templates'
import { defaultSchema, TEMPLATE_LABELS, TEMPLATE_TYPES } from '../../domain/tcm/templates/schema'
import { loadRetentionDays, saveRetentionDays } from './core/records/retention'
import { loadPersonalModel } from './core/llm/personal'
import { TemplateStudio } from './TemplateStudio'
import './groundwork.css'
import { HerbLibrary } from './HerbLibrary'
import { listHerbs } from './core/herbs'

type Item = keyof typeof GROUNDWORK_ITEMS
const keys = Object.keys(GROUNDWORK_ITEMS) as Item[]
export function HallGroundwork({ store, onReady, onDone }: { store: LocalStore; onReady?: (ready: boolean) => void; onDone?: () => void }) {
  const [value, setValue] = useState<Groundwork | null>(null), [missing, setMissing] = useState<string[]>([]), [item, setItem] = useState<Item>('templates')
  const [days, setDays] = useState(90), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [herbOpen, setHerbOpen] = useState(false)
  const [edited, setEdited] = useState(false)
  const refresh = async (advance = false) => {
    const status = await groundworkStatus(store)
    setValue(status.value); setMissing(status.missing); onReady?.(!status.missing.length)
    if (advance) setItem(keys.find(key => status.missing.includes(GROUNDWORK_ITEMS[key])) ?? 'model')
  }
  useEffect(() => { let active = true; void (async () => {
    const [status, retention] = await Promise.all([groundworkStatus(store), loadRetentionDays(store)])
    if (!active) return
    setValue(status.value); setMissing(status.missing); setDays(retention); setItem(keys.find(key => status.missing.includes(GROUNDWORK_ITEMS[key])) ?? 'model'); onReady?.(!status.missing.length)
  })().catch(cause => { if (active) setError(`读取失败：${cause.message}`) }); return () => { active = false } }, [store])
  const persist = async (key: Item, candidate = value) => {
    if (!candidate) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (key === 'templates') {
        let rows = await loadTemplates(store)
        for (const type of TEMPLATE_TYPES) if (!rows.some(row => row.type === type && row.status === 'active')) {
          const existing = rows.find(row => row.type === type && row.status === 'draft')
          const draft = existing ?? await saveTemplateDraft(store, type, TEMPLATE_LABELS[type] + '模板', defaultSchema(type))
          await publishTemplate(store, draft.id); rows = await loadTemplates(store)
        }
      }
      if (key === 'model' && !await loadPersonalModel(store)) throw Error('模型还没接好，请到模型设置测试连接')
      if (key === 'retention') await saveRetentionDays(store, days)
      const next = key === 'herbs' && candidate.herbs === 'pending'
        ? { ...candidate, herbs: (await listHerbs(store)).length ? 'ready' as const : 'pending' as const }
        : candidate
      if (key === 'herbs' && next.herbs === 'pending') throw Error('先录入至少一味药材，或选择“不备药”')
      const checked = [...new Set([...next.checked, key])]
      await saveGroundwork(store, { ...next, checked })
      await refresh(true); setEdited(false); setNotice('已保存。'); window.dispatchEvent(new Event('aster:data-changed'))
    } catch (cause) { setError(`没保存成功：${cause instanceof Error ? cause.message : '本机存储不可用'}`); onReady?.(false) }
    finally { setBusy(false) }
  }
  if (!value) return <section aria-label="开馆基础工作"><p>{error || '正在读取基础工作…'}</p>{error && <button type="button" onClick={() => void refresh(true).catch(cause => setError(cause.message))}>重新读取</button>}</section>
  if (herbOpen) return <section className="groundwork" aria-label="药材库准备"><HerbLibrary store={store} role="老师" /><button type="button" onClick={() => { setHerbOpen(false); void refresh() }}>返回基础工作</button></section>
  const patch = (next: Partial<Groundwork>) => { setValue({ ...value, ...next }); setEdited(true); setNotice(''); onReady?.(false) }
  const schedule = value.schedule
  const editPeriods = (day: string, periods: Period[]) => patch({ schedule: { ...schedule, week: { ...schedule.week, [day]: periods } } })
  return <section aria-label="开馆基础工作" className="groundwork">
    <h2>开馆基础工作</h2>
    <p role="status">{missing.length ? `还差 ${missing.length} 项：${missing.join('、')}` : '基础工作已齐，可以邀请学生了。'}</p>
    <div className="ground-tabs">{keys.map(key => <button type="button" disabled={busy} aria-pressed={item === key} key={key} onClick={() => { setItem(key); setError(''); setNotice('') }}>{missing.includes(GROUNDWORK_ITEMS[key]) ? '○ ' : '✓ '}{GROUNDWORK_ITEMS[key]}</button>)}</div>
    <h3>{GROUNDWORK_ITEMS[item]}</h3>
    {item === 'templates' && <>
      <p>问诊、病历、施治、开方各有一套默认骨架。先用默认就能开馆，以后随时改。</p>
      <details><summary>看看或修改四类模板</summary><TemplateStudio store={store} onSaved={() => void refresh().catch(cause => setError(cause.message))} /></details>
    </>}
    {item === 'schedule' && <>
      <label>老师所在时区<input value={schedule.timezone} placeholder="Asia/Shanghai" onChange={e => patch({ schedule: { ...schedule, timezone: e.target.value } })} /></label>
      <label>每个时段<select value={schedule.duration} onChange={e => patch({ schedule: { ...schedule, duration: Number(e.target.value) as 15 | 30 | 45 | 60 } })}>{[15, 30, 45, 60].map(minutes => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
      <label>每时段最多接待几位<input type="number" min="1" max="20" value={schedule.capacity} onChange={e => patch({ schedule: { ...schedule, capacity: Number(e.target.value) } })} /></label>
      <details><summary>周一至周日的排班（展开修改）</summary>{['日', '一', '二', '三', '四', '五', '六'].map((day, index) => <fieldset key={day}><legend>周{day}</legend>
        {schedule.week[String(index)].map((period, n) => <div className="ground-period" key={n}>
          <label>开始<input aria-label={`周${day}第${n + 1}段开始`} value={period.start} onChange={e => editPeriods(String(index), schedule.week[String(index)].map((v, k) => k === n ? { ...v, start: e.target.value } : v))} /></label>
          <label>结束<input aria-label={`周${day}第${n + 1}段结束`} value={period.end} onChange={e => editPeriods(String(index), schedule.week[String(index)].map((v, k) => k === n ? { ...v, end: e.target.value } : v))} /></label>
          <button type="button" aria-label={`删除周${day}第${n + 1}段`} onClick={() => editPeriods(String(index), schedule.week[String(index)].filter((_, k) => k !== n))}>删除</button>
        </div>)}
        <button type="button" onClick={() => editPeriods(String(index), [...schedule.week[String(index)], { start: '09:00', end: '12:00' }])}>添加周{day}时段</button>
      </fieldset>)}</details>
      <details><summary>日期例外：休息或临时加诊</summary>
        {schedule.exceptions.map((exception, n) => <fieldset key={n}>
          <label>日期<input type="date" value={exception.date} onChange={e => patch({ schedule: { ...schedule, exceptions: schedule.exceptions.map((v, k) => k === n ? { ...v, date: e.target.value } : v) } })} /></label>
          <label>这天的安排<select value={exception.kind} onChange={e => patch({ schedule: { ...schedule, exceptions: schedule.exceptions.map((v, k) => k === n ? { ...v, kind: e.target.value as typeof v.kind, ...(e.target.value === 'extra' ? { periods: [{ start: '18:00', end: '19:00' }] } : {}) } : v) } })}><option value="off">整天休息</option><option value="morning-off">上午休息（12 点前）</option><option value="afternoon-off">下午休息（12 点后）</option><option value="extra">临时加诊</option></select></label>
          {exception.kind === 'extra' && <div className="ground-period">{(['start', 'end'] as const).map(part => <label key={part}>加诊{part === 'start' ? '开始' : '结束'}<input value={exception.periods?.[0]?.[part] ?? ''} onChange={e => patch({ schedule: { ...schedule, exceptions: schedule.exceptions.map((v, k) => k === n ? { ...v, periods: [{ ...v.periods![0], [part]: e.target.value }] } : v) } })} /></label>)}</div>}
          <button type="button" onClick={() => patch({ schedule: { ...schedule, exceptions: schedule.exceptions.filter((_, k) => k !== n) } })}>删除这条例外</button>
        </fieldset>)}
        <button type="button" onClick={() => patch({ schedule: { ...schedule, exceptions: [...schedule.exceptions, { date: '', kind: 'off' }] } })}>添加日期例外</button>
      </details>
      <button type="button" onClick={() => patch({ schedule: defaultSchedule() })}>恢复默认排班</button>
    </>}
    {item === 'invitation' && <>
      <label>邀约怎么发<select value={value.invitation.mode} onChange={e => patch({ invitation: { ...value.invitation, mode: e.target.value as 'auto' | 'review' } })}><option value="review">老师过目后再发</option><option value="auto">自动邀约</option></select></label>
      <label>多久没来该请了（天）<input type="number" min="1" max="3650" value={value.invitation.afterDays} onChange={e => patch({ invitation: { ...value.invitation, afterDays: Number(e.target.value) } })} /></label>
      <p className="nl-quiet">这里先定方式。邀约会在排班与预约功能接好后执行。</p>
    </>}
    {item === 'herbs' && <>
      <label><input type="radio" name="herbs" checked={value.herbs === 'none'} onChange={() => patch({ herbs: 'none' })} />不备药</label>
      <label><input type="radio" name="herbs" checked={value.herbs !== 'none'} onChange={() => patch({ herbs: 'pending' })} />我自己备药，要建药材库</label>
      {value.herbs === 'pending' && <p role="status">药材库暂未开放，尚未建库。这项可以先保存；建库完成前不能邀请新学生，也可以先选“不备药”。</p>}
      {value.herbs !== 'none' && <button type="button" onClick={() => setHerbOpen(true)}>前往药材库</button>}
    </>}
    {item === 'retention' && <><label>旧病历保留天数<input type="number" min="30" max="1095" value={days} onChange={e => { setDays(Number(e.target.value)); setEdited(true); onReady?.(false) }} /></label><p className="nl-quiet">默认 90 天，可设 30 天到 3 年；最新方案和长期观察沿用现有规则。</p></>}
    {item === 'model' && <p>沿用已经测试连接的个人模型。以后可在“模型与偏好设置”更换。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {(missing.length > 0 || edited) && <button type="button" className="nl-primary" disabled={busy} onClick={() => void persist(item)}>就这样，保存{GROUNDWORK_ITEMS[item]}</button>}
    {!missing.length && onDone && <button type="button" onClick={onDone}>返回我的馆</button>}
  </section>
}

export function GroundworkNotice({ store, onOpen }: { store: LocalStore; onOpen: () => void }) {
  const [missing, setMissing] = useState<string[]>([]), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () => { void groundworkStatus(store).then(result => { if (active) { setMissing(result.missing); setError('') } }).catch(cause => { if (active) setError(cause.message) }) }
    refresh(); window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store])
  return missing.length || error ? <aside className="nl-card ground-notice"><p>{error || `开馆基础工作还差 ${missing.length} 项：${missing.join('、')}`}</p><button type="button" onClick={onOpen}>补齐基础工作</button></aside> : null
}
