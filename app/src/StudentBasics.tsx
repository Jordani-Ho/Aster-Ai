import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { cities } from '../../domain/tcm/bazi'
import {
  BirthChangeNeedsConfirm, REQUIRED_LABELS, SHICHEN_NAMES, loadBasics, missingLabels, saveBasics,
  type BasicsGender, type Shichen, type StudentBasics,
} from './core/basics'
import './newui.css'

// V2-23 进馆基础信息：必填四项（称呼、性别、出生日期、居住城市）填完才能第一次问诊；
// 其余可以写“无”或以后补。资料只留在本机；老师端只收到称呼、性别、年龄、八字、城市。
export function StudentBasicsPage({ store, title = '基础信息', note, onBack, onSaved }: {
  store: LocalStore
  title?: string
  note?: string
  /** 不给就没有返回键（进馆时必须先填好）。 */
  onBack?: () => void
  onSaved?: (missing: string[]) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [alias, setAlias] = useState('')
  const [gender, setGender] = useState<BasicsGender | ''>('')
  const [birthDate, setBirthDate] = useState('')
  const [shichen, setShichen] = useState<Shichen | ''>('')
  const [birthPlace, setBirthPlace] = useState('')
  const [city, setCity] = useState('')
  const [diagnoses, setDiagnoses] = useState('')
  const [history, setHistory] = useState('')
  const [meds, setMeds] = useState('')
  const [allergies, setAllergies] = useState('')
  const [wake, setWake] = useState('')
  const [sleep, setSleep] = useState('')
  const [missing, setMissing] = useState<string[]>([])
  const [confirmBirth, setConfirmBirth] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 从首页底部点进来时，页面从顶上开始看。
  useEffect(() => { try { window.scrollTo(0, 0) } catch { /* 测试环境没有 window */ } }, [])

  useEffect(() => {
    let active = true
    void loadBasics(store).then(value => {
      if (!active) return
      fill(value); setMissing(missingLabels(value)); setLoaded(true)
    }).catch(() => { if (active) { setError('基础信息暂时读不出来，请稍后再试。'); setLoaded(true) } })
    return () => { active = false }
  }, [store])

  const fill = (value: Partial<StudentBasics>) => {
    setAlias(value.alias ?? ''); setGender(value.gender ?? ''); setBirthDate(value.birthDate ?? '')
    setShichen(value.birthShichen ?? ''); setBirthPlace(value.birthPlace ?? ''); setCity(value.city ?? '')
    setDiagnoses((value.diagnoses ?? []).join('\n')); setHistory(value.history ?? ''); setMeds(value.meds ?? '')
    setAllergies(value.allergies ?? ''); setWake(value.routine?.wake ?? ''); setSleep(value.routine?.sleep ?? '')
  }

  const save = async (confirmed = false) => {
    if (busy) return
    setBusy(true); setError(''); setStatus('')
    try {
      const result = await saveBasics(store, {
        alias, gender: gender === '' ? undefined : gender, birthDate: birthDate === '' ? undefined : birthDate,
        birthShichen: shichen === '' ? null : shichen, birthPlace: birthPlace || null, city: city || undefined,
        diagnoses: diagnoses.split(/\n|；|;/), history, meds, allergies, routine: { wake: wake || null, sleep: sleep || null },
      }, { confirmBirth: confirmed })
      setConfirmBirth(false)
      fill(result.basics); setMissing(result.missing)
      setStatus(result.missing.length === 0 ? '已保存。' : `已保存。还差：${result.missing.join('、')}`)
      onSaved?.(result.missing)
    } catch (cause) {
      if (cause instanceof BirthChangeNeedsConfirm) setConfirmBirth(true)
      else setError(cause instanceof Error ? cause.message : '没有保存成功，请重试。')
    } finally { setBusy(false) }
  }

  const required = (key: keyof typeof REQUIRED_LABELS) => missing.includes(REQUIRED_LABELS[key]) ? ' basics-missing' : ''

  return <div className="nl-shell">
    <header className="nl-flow-head">
      {onBack ? <button type="button" className="nl-back" aria-label="返回" onClick={onBack}>‹</button> : <span className="nl-back-placeholder" />}
      <div><h1>{title}</h1><small>只留在这部手机上</small></div>
    </header>
    <div className="nl-flow-body basics-page">
      {note && <p className="nl-card basics-note" role="status">{note}</p>}
      {loaded && !note && missing.length > 0 && <p className="basics-todo" role="status">还差：{missing.join('、')}</p>}

      <section className="nl-card" aria-label="必填">
        <h2>先填这四项</h2>
        <label className={'basics-field' + required('alias')}>称呼<input aria-label="称呼" value={alias} maxLength={30} disabled={busy} onChange={event => setAlias(event.target.value)} placeholder="老师怎么称呼您" /></label>
        <fieldset className={'basics-field' + required('gender')} disabled={busy}>
          <legend>性别</legend>
          <div className="basics-choices">
            {(['male', 'female', 'other'] as const).map(value => <label key={value} className="basics-choice">
              <input type="radio" name="basics-gender" checked={gender === value} onChange={() => setGender(value)} />{value === 'male' ? '男' : value === 'female' ? '女' : '其他'}
            </label>)}
          </div>
        </fieldset>
        <label className={'basics-field' + required('birthDate')}>出生日期<input aria-label="出生日期" type="date" value={birthDate} disabled={busy} onChange={event => setBirthDate(event.target.value)} /></label>
        <label className={'basics-field' + required('city')}>居住城市<select aria-label="居住城市" value={city} disabled={busy} onChange={event => setCity(event.target.value)}>
          <option value="">请选择</option>
          {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
        </select></label>
      </section>

      <details className="nl-section" open={loaded && missing.length === 0}>
        <summary>其余可以以后补</summary>
        <label className="basics-field">出生时辰<select aria-label="出生时辰" value={shichen} disabled={busy} onChange={event => setShichen(event.target.value as Shichen | '')}>
          <option value="">不知道</option>
          {SHICHEN_NAMES.map(name => <option key={name} value={name}>{name}时</option>)}
        </select></label>
        <label className="basics-field">出生地<select aria-label="出生地" value={birthPlace} disabled={busy} onChange={event => setBirthPlace(event.target.value)}>
          <option value="">不填</option>
          {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
        </select></label>
        <label className="basics-field">西医诊断<textarea aria-label="西医诊断" rows={2} value={diagnoses} disabled={busy} onChange={event => setDiagnoses(event.target.value)} placeholder="有就填，一行一条；只留在本机" /></label>
        <label className="basics-field">既往病史<textarea aria-label="既往病史" rows={2} value={history} disabled={busy} onChange={event => setHistory(event.target.value)} placeholder="没有就写“无”" /></label>
        <label className="basics-field">在用药<textarea aria-label="在用药" rows={2} value={meds} disabled={busy} onChange={event => setMeds(event.target.value)} placeholder="没有就写“无”" /></label>
        <label className="basics-field">过敏<textarea aria-label="过敏" rows={2} value={allergies} disabled={busy} onChange={event => setAllergies(event.target.value)} placeholder="没有就写“无”" /></label>
        <div className="basics-routine">
          <label className="basics-field">平时几点起<input aria-label="平时几点起" type="time" value={wake} disabled={busy} onChange={event => setWake(event.target.value)} /></label>
          <label className="basics-field">平时几点睡<input aria-label="平时几点睡" type="time" value={sleep} disabled={busy} onChange={event => setSleep(event.target.value)} /></label>
        </div>
        <p className="nl-quiet">既往病史、在用药、过敏会在问诊时自动带进卡片，您可以改。</p>
      </details>

      {confirmBirth && <div className="nl-card basics-confirm" role="alertdialog" aria-label="确认修改出生信息">
        <p>改出生日期或时辰会影响八字推算。确定要改吗？</p>
        <div className="basics-confirm-actions">
          <button type="button" disabled={busy} onClick={() => setConfirmBirth(false)}>先不改</button>
          <button type="button" className="nl-primary" disabled={busy} onClick={() => void save(true)}>确定修改</button>
        </div>
      </div>}
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {status && <p role="status" className="nl-quiet">{status}</p>}
    </div>
    <div className="basics-foot">
      <button type="button" className="nl-primary" disabled={busy || !loaded} onClick={() => void save(false)}>保存</button>
    </div>
  </div>
}
