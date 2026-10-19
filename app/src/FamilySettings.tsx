import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { loadProfile } from './core/intake/session'
import { cities } from '../../domain/tcm/bazi'
import { addFamilyMember, FAMILY_RELATIONS, RELATION_LABELS, loadFamilyMembers, removeFamilyMember, setFamilyMemberCity, type FamilyGender, type FamilyMember, type FamilyRelation } from './core/family'
import { uiError } from './core/onboarding/ui'

// M1-22：一部手机照顾全家。家人只给没有独立自理或支付能力的老人、孩子用；
// 每位家人是独立身份，共用本人接入的大模型，账本仍是本人这一本。
export function FamilySettings({ store, identity, onChanged }: { store: LocalStore; identity: Identity; onChanged?: () => void }) {
  const [members, setMembers] = useState<FamilyMember[]>([])
  const [alias, setAlias] = useState('')
  const [relation, setRelation] = useState<FamilyRelation>('other')
  const [gender, setGender] = useState<FamilyGender>('female')
  const [birthDate, setBirthDate] = useState('')
  const [city, setCity] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => { void loadFamilyMembers(store).then(setMembers).catch(() => setError('家人列表读取失败，请稍后重试。')) }
  useEffect(() => {
    refresh()
    void loadProfile(store).then(profile => { if (!city && profile.city.value) setCity(profile.city.value) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const add = async () => {
    if (busy) return
    setBusy(true); setError(''); setStatus('')
    try {
      const member = await addFamilyMember(store, identity, { alias, relation, gender, birthDate, city: city || null })
      setMembers(await loadFamilyMembers(store))
      setAlias(''); setBirthDate(''); setStatus(`已添加家人：${member.alias}`)
      onChanged?.()
    } catch (cause) { setError(uiError(cause, '添加家人没有成功，请检查后重试。')) } finally { setBusy(false) }
  }

  const remove = async (account: number) => {
    if (busy) return
    setBusy(true); setError(''); setStatus('')
    try {
      setMembers(await removeFamilyMember(store, account))
      setStatus('已移除这位家人，他的本机资料也已清除。')
      onChanged?.()
    } catch (cause) { setError(uiError(cause, '移除家人没有成功，请稍后重试。')) } finally { setBusy(false) }
  }

  // V2-06：家人可能和管理人不住在一起，城市要能单独改（影响这位家人的真太阳时/时辰）。
  const changeCity = async (account: number, value: string) => {
    setError(''); setStatus('')
    try {
      setMembers(await setFamilyMemberCity(store, account, value === '' ? null : value))
      setStatus('已更新家人的居住城市；之后的记录按新城市算时辰。')
      onChanged?.()
    } catch (cause) { setError(uiError(cause, '居住城市没有改成功，请重试。')) }
  }

  return <details><summary>添加家人</summary>
    <p className="privacy-note">给没有独立自理或支付能力的老人、孩子用。家人共用您接入的大模型，不需要各自接入；钱账记在您这一本账上，每笔可以注明家人。</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {members.length > 0 && <ul>
      {members.map(member => <li key={member.account}>{member.alias} · {RELATION_LABELS[member.relation]} · {member.birthDate}
        <label>居住城市<select value={member.city ?? ''} onChange={event => void changeCity(member.account, event.target.value)}>
          <option value="">跟本人一样</option>
          {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
        </select></label>
        <button type="button" disabled={busy} onClick={() => void remove(member.account)}>移除</button>
      </li>)}
    </ul>}
    <label>称呼<input value={alias} maxLength={12} onChange={event => setAlias(event.target.value)} placeholder="例如：爸爸" /></label>
    <label>关系<select value={relation} onChange={event => setRelation(event.target.value as FamilyRelation)}>
      {FAMILY_RELATIONS.map(value => <option key={value} value={value}>{RELATION_LABELS[value]}</option>)}
    </select></label>
    <label>性别<select value={gender} onChange={event => setGender(event.target.value as FamilyGender)}>
      <option value="female">女</option><option value="male">男</option>
    </select></label>
    <label>出生日期<input type="date" value={birthDate} onChange={event => setBirthDate(event.target.value)} /></label>
    <label>居住城市<select value={city} onChange={event => setCity(event.target.value)}>
      <option value="">跟本人一样</option>
      {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
    </select></label>
    <button type="button" disabled={busy || alias.trim() === '' || birthDate === ''} onClick={() => void add()}>添加家人</button>
  </details>
}
