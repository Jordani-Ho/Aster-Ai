import { TonguePair } from './TonguePair'
import { RecordPhotos } from './RecordPhotos'
import { PostureSummary } from './PostureTool'
import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import { INTAKE_COLLECTIONS } from './core/intake'
import { groupReceivedRecords, listReceivedRecords, recordPhotos, type GroupedRecord, type ReceivedRecord } from './core/inbox'
import { intakeDisplayLabel } from './core/record/in-person'
import type { Encounter } from './core/record/types'
import type { LocalStore } from './core/store'
import './records.css'
import { brewOneWithStudentAgent, getStudentHerbAdvice, type StudentHerbAdvice } from './core/herbs/agent'

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
  const recordOuter = record
  return <>
    <p className="record-meta">{new Date(encounter.createdAt).toLocaleString()} · 老师 {encounter.teacher.slice(0, 8)}… · {revisionLabel(encounter)}</p>
    <section className="record-section">
      <h3>主诉</h3>
      <p>{textField(encounter.intake.chiefComplaint)} <span className="record-source">{intakeDisplayLabel(encounter, 'chiefComplaint')}</span></p>
      {encounter.intake.presentIllness.value !== null && <p className="record-detail">现病史：{textField(encounter.intake.presentIllness)}</p>}
      {encounter.intake.history.value !== null && <p className="record-detail">既往史：{textField(encounter.intake.history)}</p>}
      {encounter.intake.medsAllergies.value !== null && <p className="record-detail">在吃的药、过敏：{textField(encounter.intake.medsAllergies)}</p>}
      {encounter.intake.tongues?.map((record,index)=><TonguePair key={index} record={record} title={`舌象 ${index+1} · ${record.shichen}时`} loadCrop={async()=>{const id=record.crop?.id;if(!id)return null;const data=await store.get(INTAKE_COLLECTIONS.attachmentData,id);if(data instanceof Uint8Array)return data;return (await recordPhotos(store,recordOuter)).find(photo=>photo.ref.id===id)?.data??null}} missingCropState="expired"/>)}
      {encounter.intake.attachments.length > 0 && <RecordPhotos record={record} store={store}/>}
      <PostureSummary postures={encounter.postures} title="体态记录" showValues={false} />
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

function RecordCard({ group, store, herbStore }: { group: GroupedRecord; store: LocalStore; herbStore: LocalStore }) {
  const latest = group.versions[0]
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [advice, setAdvice] = useState<StudentHerbAdvice | null>(null)
  const prescription = latest.encounter.plan.prescription.value
  useEffect(() => {
    let active = true
    const refresh = () => { void getStudentHerbAdvice(herbStore, prescription).then(value => { if (active) setAdvice(value) }).catch(() => {}) }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [herbStore, latest.encounter.id, latest.event.id, prescription])
  const brewOne = async () => {
    if (!prescription || busy) return
    setBusy(true); setNotice('')
    try {
      const result = await brewOneWithStudentAgent(herbStore, latest.encounter.id, prescription, crypto.randomUUID().replaceAll('-', ''))
      const messages = [
        ...(result.shortages.length ? ['库存不足：' + result.shortages.map(item => `${item.herb}差 ${item.missing}${item.unit}`).join('、') + '；本剂未扣。'] : []),
        ...result.skipped,
      ]
      if (result.deducted > 0) messages.unshift('已记下煎了一剂。')
      setNotice(messages.join(' ') || '没有库存扣减；请核对家里库存。')
      window.dispatchEvent(new Event('aster:data-changed'))
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '没有扣库存，请检查剂量和药材单位。') }
    finally { setBusy(false) }
  }
  return <article className="record-card">
    <RecordBody record={latest} store={store} />
    {advice?.labels.length ? <section className="record-section" aria-label="家里库存对照">
      <h3>家里库存对照</h3>
      <ul>{advice.labels.map((item, index) => <li key={`${item.herb}-${index}`}>{item.herb} · {item.text}</li>)}</ul>
      {advice.reminders.length > 0 && <p role="status" className="record-detail">补货提醒：{advice.reminders.join('；')}</p>}
    </section> : null}
    {prescription?.items.length ? <div className="record-brew"><button type="button" disabled={busy} onClick={() => void brewOne()}>{busy ? '正在记…' : '煎了一剂'}</button>{notice && <p role="status">{notice}</p>}</div> : null}
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
  /** 根身份的家人共用药材库；病历本身仍从当前身份分片读取。 */
  herbStore: LocalStore
  store: LocalStore
  onBack: () => void
  /** V2-16：挪进“记录”标签时不需要返回按钮。 */
  embedded?: boolean
}

// 学生端病历页：只显示 verifySignedEncounter 通过的病历；同一份病历的修订折叠保留。
export function StudentRecordsPage({ identity, store, herbStore, onBack, embedded = false }: StudentRecordsPageProps) {
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
  return <main className={embedded ? 'records-page embedded' : 'records-page'}>
    <header className="records-head">
      {!embedded && <button className="records-back" onClick={onBack}>返回</button>}
      <h1>我的病历</h1>
      <p>只显示老师本人签过字、签名有效的病历；旧版本折叠保留，不删除。</p>
    </header>
    {error && <p role="alert" className="records-error">{error}</p>}
    {loading && <p className="records-note">正在读取本机病历…</p>}
    {!loading && groups.length === 0 && <p className="records-note">还没有收到的病历。老师签字交还后会出现在这里。</p>}
    {groups.map(group => <RecordCard key={group.encounterId} group={group} store={store} herbStore={herbStore} />)}
  </main>
}
