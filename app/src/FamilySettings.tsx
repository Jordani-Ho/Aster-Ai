import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { loadProfile } from './core/intake/session'
import { cities } from '../../domain/tcm/bazi'
import { addFamilyMember, FAMILY_RELATIONS, RELATION_LABELS, loadFamilyMembers, removeFamilyMember, setFamilyMemberCity, type FamilyGender, type FamilyMember, type FamilyRelation } from './core/family'
import { chooseFamilyLink, listFamilyResults, sendFamilyReidentify, type FamilyResultRow, type SendEnvelope } from './core/reidentify'
import { uiError } from './core/onboarding/ui'

// M1-22：一部手机照顾全家。V2-07b：管理人换手机重新添加家人后，老师凭旧代管关系自动把旧家人的记录与钱账对过来。
export function FamilySettings({ store, identity, send, onChanged }: { store: LocalStore; identity: Identity; send?: SendEnvelope; onChanged?: () => void }) {
  const [members, setMembers] = useState<FamilyMember[]>([])
  const [results, setResults] = useState<FamilyResultRow[]>([])
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [alias, setAlias] = useState('')
  const [relation, setRelation] = useState<FamilyRelation>('other')
  const [gender, setGender] = useState<FamilyGender>('female')
  const [birthDate, setBirthDate] = useState('')
  const [city, setCity] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => { void loadFamilyMembers(store).then(setMembers).catch(() => setError('家人列表读取失败，请稍后重试。')) }
  const refreshResults = () => { void listFamilyResults(store).then(setResults).catch(() => {}) }
  useEffect(() => {
    refresh(); refreshResults()
    void loadProfile(store).then(profile => { if (!city && profile.city.value) setCity(profile.city.value) }).catch(() => {})
    const changed = () => refreshResults()
    window.addEventListener('aster:data-changed', changed)
    return () => window.removeEventListener('aster:data-changed', changed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // 管理人把刚添加的家人清单发给老师；老师自动按旧代管关系匹配，不需要老师逐个点“是”。
  const askFamilyRecords = async (): Promise<number | null> => {
    if (!send) { setError('连上社区后才能找回家人的记录。'); return null }
    try {
      const claims = await sendFamilyReidentify({ store, identity: identity.publicKey, send })
      setStatus(claims.length === 0 ? '没有需要找回的家人记录，或管理人还没被老师认回。' : `已请老师核对 ${claims.length} 位家人的记录。`)
      return claims.length
    } catch (cause) { setError(uiError(cause, '暂时没能发出家人找回请求，请稍后重试。')); return null }
  }

  const add = async () => {
    if (busy) return
    setBusy(true); setError(''); setStatus('')
    try {
      const member = await addFamilyMember(store, identity, { alias, relation, gender, birthDate, city: city || null })
      setMembers(await loadFamilyMembers(store))
      setAlias(''); setBirthDate(''); setStatus(`已添加家人：${member.alias}`)
      onChanged?.()
      // 添加后自动发一次家人认回清单；称呼一致时记录与钱账会自动回来。
      if (send) { void askFamilyRecords() }
      refreshResults()
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

  // 称呼对不上时，管理人手动选一位旧家人对上；不选就当新家人。
  const linkFamily = async (member: FamilyMember) => {
    if (!send) { setError('连上社区后才能对回家人。'); return }
    const oldKey = choices[member.publicKey]
    if (!oldKey) { setError('请先选一位旧家人。'); return }
    setBusy(true); setError(''); setStatus('')
    try {
      await chooseFamilyLink({ store, identity: identity.publicKey, newKey: member.publicKey, oldKey, send })
      setStatus('已把这位家人对上，记录和钱账会回来。')
    } catch (cause) { setError(uiError(cause, '没能把这位家人对上，请稍后重试。')) } finally { setBusy(false) }
  }

  return <details><summary>添加家人</summary>
    <p className="privacy-note">给没有独立自理或支付能力的老人、孩子用。家人共用您接入的大模型，不需要各自接入；钱账记在您这一本账上，每笔可以注明家人。</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {members.length > 0 && <ul>
      {members.map(member => {
        const result = results.find(item => item.newKey === member.publicKey)
        return <li key={member.account}>{member.alias} · {RELATION_LABELS[member.relation]} · {member.birthDate}
          <label>居住城市<select value={member.city ?? ''} onChange={event => void changeCity(member.account, event.target.value)}>
            <option value="">跟本人一样</option>
            {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
          </select></label>
          <button type="button" disabled={busy} onClick={() => void remove(member.account)}>移除</button>
          {result?.status === 'matched'
            ? <p className="privacy-note">这位家人的记录与钱账正在回来。</p>
            : result?.status === 'unresolved'
              ? <div>
                <p role="status">这位家人没找到原来的记录；可以选一位旧家人对上，不选就当新家人。</p>
                <label>旧家人<select value={choices[member.publicKey] ?? ''} disabled={busy} onChange={event => setChoices(previous => ({ ...previous, [member.publicKey]: event.target.value }))}>
                  <option value="">请选择</option>
                  {result.candidates.map(candidate => <option key={candidate.oldKey} value={candidate.oldKey}>{candidate.alias} · {candidate.oldKey.slice(-6)}</option>)}
                </select></label>
                <button type="button" disabled={busy || !choices[member.publicKey]} onClick={() => void linkFamily(member)}>对上</button>
              </div>
              : null}
        </li>
      })}
    </ul>}
    {members.length > 0 && <button type="button" disabled={busy || !send} onClick={() => void askFamilyRecords()}>找回家人记录</button>}
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
