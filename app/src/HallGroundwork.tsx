import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { defaultSchedule, GROUNDWORK_ITEMS, groundworkStatus, saveGroundwork, type Groundwork, type Period } from './core/hall/groundwork'
import { loadTemplates, saveTemplateDraft, publishTemplate } from './core/templates'
import { defaultSchema, TEMPLATE_LABELS, TEMPLATE_TYPES } from '../../domain/tcm/templates/schema'
import { loadRetentionDays, saveRetentionDays } from './core/records/retention'
import { TemplateStudio } from './TemplateStudio'
import './groundwork.css'
import { HerbLibrary } from './HerbLibrary'
import { listHerbs } from './core/herbs'
import { appointmentsAffectedBySchedule, cancelAppointment, type Appointment } from './core/appointments'
import { listTeacherRecords } from './core/records/teacher'
import type { Identity } from './core/identity'
import type { SendEnvelope } from './core/inbox'
import { loadOwnStorefront, publishStorefront, sendStorefrontTo, verifyStorefrontEvent } from './core/storefront'
import { teacherStudentCandidates } from './core/reidentify'
import { TimeSettings } from './TimeSettings'

type Item = keyof typeof GROUNDWORK_ITEMS
const keys = Object.keys(GROUNDWORK_ITEMS) as Item[]
export function HallGroundwork({ store, identity, send, onDone, onStatus }: { store: LocalStore; identity?: Identity; send?: SendEnvelope; onDone?: () => void; onStatus?: (ready: boolean) => void }) {
  const [value, setValue] = useState<Groundwork | null>(null), [missing, setMissing] = useState<string[]>([]), [item, setItem] = useState<Item>('templates')
  const [days, setDays] = useState(90), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [herbOpen, setHerbOpen] = useState(false)
  const [herbChosen, setHerbChosen] = useState(false)
  const [edited, setEdited] = useState(false)
  const [scheduleConflicts, setScheduleConflicts] = useState<{ value: Groundwork; rows: Appointment[]; names: Record<string, string> } | null>(null)
  const refresh = async (advance = false) => {
    const status = await groundworkStatus(store)
    setValue(status.value); setMissing(status.missing); onStatus?.(status.missing.length === 0)
    if (advance) setItem(keys.find(key => status.missing.includes(GROUNDWORK_ITEMS[key])) ?? 'model')
  }
  useEffect(() => { let active = true; void (async () => {
    const [status, retention] = await Promise.all([groundworkStatus(store), loadRetentionDays(store)])
    if (!active) return
    setValue(status.value); setMissing(status.missing); onStatus?.(status.missing.length === 0); setDays(retention); setItem(keys.find(key => status.missing.includes(GROUNDWORK_ITEMS[key])) ?? 'model')
  })().catch(cause => { if (active) setError(`读取失败：${cause.message}`) }); return () => { active = false } }, [store])
  const persist = async (key: Item, candidate = value, scheduleChoice: 'keep' | 'cancel' | null = null) => {
    if (!candidate) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (key === 'schedule' && scheduleChoice === null) {
        const rows = await appointmentsAffectedBySchedule(store, candidate.schedule)
        if (rows.length) {
          const records = await listTeacherRecords(store), names: Record<string, string> = {}
          for (const record of records) {
            const alias = record.encounter.profile.alias.value
            if (typeof alias === 'string' && alias.trim()) names[record.student] = alias.trim()
          }
          setScheduleConflicts({ value: candidate, rows, names })
          setNotice('排班改动会影响已确认预约，请先确认是否保留。')
          return
        }
      }
      if (key === 'schedule' && scheduleChoice === 'cancel') {
        if (!identity || !send) throw Error('需要连上中继后才能取消并通知学生')
        const affected = scheduleConflicts?.rows ?? await appointmentsAffectedBySchedule(store, candidate.schedule)
        for (const appointment of affected) {
          const current = await store.get('appointments', appointment.offerId) as Appointment | undefined
          if (current?.status === 'cancelled' && current.reason === 'schedule_changed') continue
          await cancelAppointment(store, identity, appointment.offerId, 'schedule_changed', new Date(), send)
        }
      }
      if (key === 'templates') {
        let rows = await loadTemplates(store)
        for (const type of TEMPLATE_TYPES) if (!rows.some(row => row.type === type && row.status === 'active')) {
          const existing = rows.find(row => row.type === type && row.status === 'draft')
          const draft = existing ?? await saveTemplateDraft(store, type, TEMPLATE_LABELS[type] + '模板', defaultSchema(type))
          await publishTemplate(store, draft.id); rows = await loadTemplates(store)
        }
      }
      if (key === 'retention') await saveRetentionDays(store, days)
      const next = key === 'herbs' && candidate.herbs === 'pending'
        ? { ...candidate, herbs: (await listHerbs(store)).length ? 'ready' as const : 'pending' as const }
        : candidate
      if (key === 'herbs' && !herbChosen && !candidate.checked.includes('herbs')) throw Error('请选择是否自己备药')
      const checked = [...new Set([...next.checked, key])]
      await saveGroundwork(store, { ...next, checked })
      if ((key === 'templates' || key === 'invitation' || key === 'schedule') && identity) {
        try {
          const own = await loadOwnStorefront(store, identity)
          const current = own.current ? verifyStorefrontEvent(own.current, identity.publicKey)?.storefront ?? null : null
          if (current) {
            await publishStorefront({ store, identity, storefront: current, receiveRecordings: next.receiveRecordings })
            if (send) {
              const students = (await teacherStudentCandidates(store)).map(candidate => candidate.student)
              await sendStorefrontTo({ store, identity, recipients: students, send })
            }
          }
        } catch { /* 本机设置已保存；已有学生下次从邀请链接读取签名偏好。 */ }
      }
      setScheduleConflicts(null); await refresh(true); setEdited(false); setNotice('已保存。'); window.dispatchEvent(new Event('aster:data-changed'))
    } catch (cause) { setError(`没保存成功：${cause instanceof Error ? cause.message : '本机存储不可用'}`) }
    finally { setBusy(false) }
  }
  if (!value) return <section aria-label="开馆基础工作"><p>{error || '正在读取基础工作…'}</p>{error && <button type="button" onClick={() => void refresh(true).catch(cause => setError(cause.message))}>重新读取</button>}</section>
  if (herbOpen) return <section className="groundwork" aria-label="药材库准备"><HerbLibrary store={store} role="老师" /><button type="button" onClick={() => setHerbOpen(false)}>返回基础工作</button></section>
  const patch = (next: Partial<Groundwork>) => { setValue({ ...value, ...next }); setScheduleConflicts(null); setEdited(true); setNotice('') }
  const schedule = value.schedule
  const editPeriods = (day: string, periods: Period[]) => patch({ schedule: { ...schedule, week: { ...schedule.week, [day]: periods } } })
  return <section aria-label="开馆基础工作" className="groundwork">
    <h2>开馆基础工作</h2>
    <p role="status">{missing.length ? '请依次看过并确认六项准备。' : '六项准备已确认。'}</p>
    <div className="ground-tabs">{keys.map(key => <button type="button" disabled={busy || (missing.includes(GROUNDWORK_ITEMS[key]) && key !== keys.find(candidate => missing.includes(GROUNDWORK_ITEMS[candidate])))} aria-pressed={item === key} key={key} onClick={() => { setItem(key); setError(''); setNotice('') }}>{GROUNDWORK_ITEMS[key]} · {missing.includes(GROUNDWORK_ITEMS[key]) ? '还没看' : '已确认'}</button>)}</div>
    <h3>{GROUNDWORK_ITEMS[item]}</h3>
    {item === 'templates' && <>
      <p>问诊、病历、施治、开方各有一套默认骨架。先用默认就能开馆，以后随时改。</p>
      <label><input type="checkbox" checked={value.receiveRecordings} onChange={event => patch({ receiveRecordings: event.target.checked })} />接收问诊录音（默认开启）</label>
      <p className="nl-quiet">学生可以选择发录音。送达后，学生端清除录音；老师签字后，老师端也清除录音。</p>
      <details><summary>看看或修改四类模板</summary><TemplateStudio store={store} onSaved={() => void refresh().catch(cause => setError(cause.message))} /></details>
    </>}
    {item === 'schedule' && <>
      <label>老师所在时区<input value={schedule.timezone} placeholder="Asia/Shanghai" onChange={e => patch({ schedule: { ...schedule, timezone: e.target.value } })} /></label>
      <TimeSettings store={store} identity={identity} sendEnvelope={send} cityOnly />
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
      {scheduleConflicts && item === 'schedule' && <section className="nl-card" aria-label="受影响的预约">
        <h4>这项改动会影响 {scheduleConflicts.rows.length} 位学生</h4>
        <ul>{scheduleConflicts.rows.map(row => <li key={row.offerId}>{scheduleConflicts.names[row.student] ?? `学生 ${row.student.slice(0, 6)}`} · {row.slotStart.replace('T', ' ').slice(0, 16)}</li>)}</ul>
        <p>选择保留预约，或取消并通知学生，再保存新的排班。</p>
        <div className="nl-actions">
          <button type="button" className="nl-primary" disabled={busy} onClick={() => void persist('schedule', scheduleConflicts.value, 'keep')}>保留预约并保存</button>
          <button type="button" className="nl-link-button" disabled={busy || !identity || !send} onClick={() => void persist('schedule', scheduleConflicts.value, 'cancel')}>取消并通知后保存</button>
        </div>
        {(!identity || !send) && <p className="nl-quiet">中继连接后才能通知学生并取消预约。</p>}
      </section>}
    </>}
    {item === 'invitation' && <>
      <label>邀约怎么发<select value={value.invitation.mode} onChange={e => patch({ invitation: { ...value.invitation, mode: e.target.value as 'auto' | 'review' } })}><option value="review">老师过目后再发</option><option value="auto">自动邀约</option></select></label>
      <label>多久没来该请了（天）<input type="number" min="1" max="3650" value={value.invitation.afterDays} onChange={e => patch({ invitation: { ...value.invitation, afterDays: Number(e.target.value) } })} /></label>
      <label>学生连续多少天不打卡，就请出名单<input type="number" min="14" max="365" placeholder="不设就不请出" value={value.invitation.leaveAfterDays ?? ''} onChange={e => patch({ invitation: { ...value.invitation, leaveAfterDays: e.target.value === '' ? null : Number(e.target.value) } })} /></label>
      <p className="nl-quiet">不设置就不会请出学生；没有作业的学生也不会请出。已确认的面诊照常进行。</p>
      <p className="nl-quiet">老师智能体每天按这个方式准备面诊邀约；排班和预约变更会在发出前核对。</p>
    </>}
    {item === 'herbs' && <>
      <label><input type="radio" name="herbs" checked={value.herbs === 'none' && (herbChosen || value.checked.includes('herbs'))} onChange={() => { setHerbChosen(true); patch({ herbs: 'none' }) }} />不备药</label>
      <label><input type="radio" name="herbs" checked={value.herbs !== 'none' && (herbChosen || value.checked.includes('herbs'))} onChange={() => { setHerbChosen(true); patch({ herbs: 'pending' }) }} />我自己备药，要建药材库</label>
      {value.herbs === 'pending' && <p role="status">药材可以现在录入，也可以以后添加。</p>}
      {value.herbs !== 'none' && <button type="button" onClick={() => setHerbOpen(true)}>前往药材库</button>}
    </>}
    {item === 'retention' && <><label>旧病历保留天数<input type="number" min="30" max="1095" value={days} onChange={e => { setDays(Number(e.target.value)); setEdited(true) }} /></label><p className="nl-quiet">默认 90 天，可设 30 天到 3 年；最新方案和长期观察沿用现有规则。</p></>}
    {item === 'model' && <p>未接个人模型时沿用社区模型；社区模型也不可用时，仍可按规则操作。以后可在“模型与偏好设置”接入。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {(missing.includes(GROUNDWORK_ITEMS[item]) || edited) && <button type="button" className="nl-primary" disabled={busy} onClick={() => void persist(item)}>就这样，保存{GROUNDWORK_ITEMS[item]}</button>}
    {onDone && <button type="button" onClick={onDone}>返回我的馆</button>}
  </section>
}
