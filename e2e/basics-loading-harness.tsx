import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StudentBasicsPage } from '../app/src/StudentBasics'
import type { LocalStore } from '../app/src/core/store'

let failOnce = true
let release!: () => void
const waiting = new Promise<void>(resolve => { release = resolve })
const first = { get: async (collection: string) => {
  if (failOnce) { failOnce = false; throw Error('synthetic read failure') }
  return collection === 'basics' ? { alias: '合成一' } : undefined
} } as unknown as LocalStore
const second = { get: async (collection: string) => {
  if (collection === 'basics') { await waiting; return { alias: '合成二' } }
  return undefined
} } as unknown as LocalStore

function Harness() {
  const [store, setStore] = useState(first)
  return <>
    <button onClick={() => setStore(second)}>切换资料</button>
    <button onClick={() => release()}>完成读取</button>
    <StudentBasicsPage store={store} />
  </>
}
createRoot(document.getElementById('root')!).render(<Harness />)
