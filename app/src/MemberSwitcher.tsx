import type { FamilyMember } from './core/family'

// M1-22：镜子页和问诊页顶部的一排头像，点一下切换当前在看谁；0 表示本人。
export function MemberSwitcher({ members, active, onChange, disabled = false }: {
  members: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active: number
  onChange: (account: number) => void
  disabled?: boolean
}) {
  const all = [{ account: 0, alias: '我' }, ...members.map(member => ({ account: member.account, alias: member.alias }))]
  return <nav aria-label="切换家人" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
    {all.map(person => <button
      key={person.account}
      type="button"
      className={active === person.account ? 'member active' : 'member'}
      aria-pressed={active === person.account}
      disabled={disabled}
      style={{ borderRadius: 999, padding: '4px 14px', border: '1px solid #9aa4b2', background: active === person.account ? '#1f6feb' : 'transparent', color: active === person.account ? '#fff' : 'inherit' }}
      onClick={() => onChange(person.account)}
    >{person.alias}</button>)}
  </nav>
}
