import { useCallback, useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { loadTeacherVenue, saveActiveTeacher, type TeacherVenue } from './core/storefront/active'

// V2-09：学生当前在用的馆。切换只改视角与发送对象，不改已有收件、方案和钱账数据。
const EMPTY: TeacherVenue = { teachers: [], active: null, labels: {}, venues: {}, call: '', name: '' }

export function useTeacherVenue(store: LocalStore): TeacherVenue & { switchTo: (teacher: string) => Promise<void>; refresh: () => void } {
  const [venue, setVenue] = useState<TeacherVenue>(EMPTY)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void loadTeacherVenue(store).then(next => { if (active) setVenue(next) }).catch(() => {})
    return () => { active = false }
  }, [store, revision])
  useEffect(() => {
    const changed = () => setRevision(value => value + 1)
    window.addEventListener('aster:data-changed', changed)
    return () => window.removeEventListener('aster:data-changed', changed)
  }, [])
  const switchTo = useCallback(async (teacher: string) => {
    await saveActiveTeacher(store, teacher, venue.teachers)
    setVenue(await loadTeacherVenue(store))
    window.dispatchEvent(new Event('aster:data-changed'))
  }, [store, venue.teachers])
  return { ...venue, switchTo, refresh: () => setRevision(value => value + 1) }
}
