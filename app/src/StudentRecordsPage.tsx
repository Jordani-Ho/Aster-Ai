import { RecordPhotos } from './RecordPhotos'
import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import { groupReceivedRecords, listReceivedRecords, type GroupedRecord, type ReceivedRecord } from './core/inbox'
import { intakeDisplayLabel } from './core/record/in-person'
import type { Encounter } from './core/record/types'
import type { LocalStore } from './core/store'
import './records.css'

function textField(field: { value: string | null } | undefined): string {
  return field && field.value !== null && field.value !== '' ? field.value : '未知'
}

function prescriptionText(encounter: Encounter): string {
  const value = encounter.plan.prescription.value
  if (!value) return '未知'
  const items = value.items.map(item => item.herb + ' ' + item.dose).join('、')
  return [items, value.method, value.days ? value.days + ' 天' : undefined].filter(Boolean).join(' · ')
}

function revisionLabel(encounter: Encounter): string {
  return '第 ' + encounter.version + ' 版'
}

function RecordBody({ record, store }: { record: ReceivedRecord; store: LocalStore }) {
  const encounter = record.encounter
  return <>
    <p className="record-meta">{new Date(encounter.createdAt).toLocaleString()} · 老师 {encounter.teacher.slice(0, 8)}… · {revisionLabel(encounter)}</p>
    <section className="record-section">
      <h3>主诉</h3>
      <p>{textField(encounter.intake.chiefComplaint)} <span className="record-source">{intakeDisplayLabel(encounter, 'chiefComplaint')}</span></p>
      {encounter.intake.presentIllness.value !== null && <p className="record-detail">现病史：{textField(encounter.intake.presentIllness)}</p>}
      {encounter.intake.history.value !== null && <p className="record-detail">既往史：{textField(encounter.intake.history)}</p>}
      {encounter.intake.medsAllergies.value !== null && <p className="record-detail">在吃的药、过敏：{textField(encounter.intake.medsAllergies)}</p>}
      {encounter.intake.attachments.length > 0 && <RecordPhotos record={record} store={store}/>}
    </section>
    <section className="record-section">
      <h3>判断</h3>
      <p>证候：{textField(encounter.judgment.pattern)}</p>
      <p>病机：{textField(encounter.judgment.mechanism)}</p>
      <p>辨证依据：{textField(encounter.judgment.rationale)}</p>
    </section>
    <section className="record-section">
      <h3>处理</h3>
      <p>治则治法：{textField(encounter.plan.principle)}</p>
      <p>方子：{prescriptionText(encounter)}</p>
      <p>医嘱：{textField(encounter.plan.advice)}</p>
      {encounter.plan.homework.length > 0 && <ul className="record-homework">
        {encounter.plan.homework.map(item => <li key={item.id}><strong>{item.title}</strong> · {item.detail}</li>)}
      </ul>}
      {encounter.plan.homework.length > 0 && <p className="record-detail">这类作业会自动进入“今日作业”的提醒日程。</p>}
    </section>
  </>
}

function RecordCard({ group, store }: { group: GroupedRecord; store: LocalStore }) {
  const latest = group.versions[0]
  return <article className="record-card">
    <RecordBody record={latest} store={store} />
    {group.versions.length > 1 && <details className="record-revisions">
      <summary>旧版本 {group.versions.length - 1} 份（保留不删）</summary>
      {group.versions.slice(1).map(record => <div key={record.event.id} className="record-revision">
        <RecordBody record={record} store={store} />
      </div>)}
    </details>}
  </article>
}

export interface StudentRecordsPageProps {
  identity: Identity
  store: LocalStore
  onBack: () => void
}

// 学生端病历页：只显示 verifySignedEncounter 通过的病历；同一份病历的修订折叠保留。
export function StudentRecordsPage({ identity, store, onBack }: StudentRecordsPageProps) {
  const [groups, setGroups] = useState<GroupedRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const refresh = () => { void listReceivedRecords(store, identity).then(records => {
      if (!cancelled) setGroups(groupReceivedRecords(records))
    }).catch(() => { if (!cancelled) setError('无法读取本机病历，请稍后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) }) }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { cancelled = true; window.removeEventListener('aster:data-changed', refresh) }
  }, [store, identity])
  return <main className="records-page">
    <header className="records-head">
      <button className="records-back" onClick={onBack}>返回</button>
      <h1>我的病历</h1>
      <p>只显示老师本人签过字、签名有效的病历；旧版本折叠保留，不删除。</p>
    </header>
    {error && <p role="alert" className="records-error">{error}</p>}
    {loading && <p className="records-note">正在读取本机病历…</p>}
    {!loading && groups.length === 0 && <p className="records-note">还没有收到的病历。老师签字交还后会出现在这里。</p>}
    {groups.map(group => <RecordCard key={group.encounterId} group={group} store={store} />)}
  </main>
}
