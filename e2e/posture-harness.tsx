import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PostureTool, PostureSummary } from '../app/src/PostureTool'
import { PostureMetricsSettings } from '../app/src/PostureMetricsSettings'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import {
  loadPostureMetrics, newPostureRecord, newPostureSegment, savePostureDraft,
  signedPostureRecords, type PostureFrame, type PosturePoint, type PostureRecord,
} from '../app/src/core/posture'
import { startInPersonEncounter } from '../app/src/core/record/in-person'
import { signEncounter } from '../app/src/core/record/sign'
import { saveTeacherRecord } from '../app/src/core/records/teacher'

// V2-30 浏览器验收：真实组件 + 可注入的骨骼检测器桩 + 合成数据，不调用真实模型（另有单独的真实资源 smoke）。
const scene = new URLSearchParams(location.search).get('scene') ?? 'tool'
async function node() {
  const prior = await resumeStore({ name: 'v230-posture' })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name: 'v230-posture' }) }
}
const session = await node()
const student = 'b'.repeat(64)
const basePoints: Record<string, PosturePoint> = {
  nose: { x: 0.5, y: 0.12, visibility: 0.95 },
  left_shoulder: { x: 0.4, y: 0.3, visibility: 0.95 }, right_shoulder: { x: 0.6, y: 0.32, visibility: 0.95 },
  left_hip: { x: 0.44, y: 0.55, visibility: 0.95 }, right_hip: { x: 0.56, y: 0.56, visibility: 0.95 },
  left_knee: { x: 0.44, y: 0.75, visibility: 0.95 }, right_knee: { x: 0.56, y: 0.75, visibility: 0.95 },
  left_ankle: { x: 0.44, y: 0.95, visibility: 0.95 }, right_ankle: { x: 0.56, y: 0.95, visibility: 0.95 },
}
const points: Record<string, PosturePoint> = structuredClone(basePoints)
if (scene !== 'real') {
  ;(globalThis as unknown as { __postureDetector: unknown }).__postureDetector = {
    async detect() { return { people: 1, points: structuredClone(points) } },
  }
}
function frame(view: 'front' | 'side' | 'video' = 'front'): PostureFrame {
  return { source: 'phone', view, at: new Date().toISOString(), width: 300, height: 400, points: structuredClone(points) }
}
async function fakeImage(): Promise<File> {
  const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 400
  const context = canvas.getContext('2d')!
  context.fillStyle = '#e9e3d5'; context.fillRect(0, 0, 300, 400)
  context.fillStyle = '#b07a5a'; context.beginPath(); context.arc(150, 70, 26, 0, Math.PI * 2); context.fill()
  context.fillStyle = '#4a6b5a'; context.fillRect(120, 100, 60, 120); context.fillRect(95, 220, 110, 20)
  context.fillRect(120, 240, 20, 120); context.fillRect(160, 240, 20, 120)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  return new File([blob!], 'synthetic-posture.png', { type: 'image/png' })
}

async function openSignedRecords(): Promise<PostureRecord[]> {
  const rows = await signedPostureRecords(session.store, student)
  return rows.map(row => row.record)
}

function Harness() {
  const [view, setView] = useState<'tool' | 'metrics' | 'signed' | 'signreview'>(scene === 'metrics' ? 'metrics' : scene === 'signed' ? 'signed' : 'tool')
  const [signed, setSigned] = useState<PostureRecord[]>([])
  const openSigned = async () => { setSigned(await openSignedRecords()); setView('signed') }
  useEffect(() => {
    const handler = () => { setSigned((globalThis as unknown as { __postureSigned?: PostureRecord[] }).__postureSigned ?? []); setView('signed') }
    window.addEventListener('posture:signed', handler)
    return () => window.removeEventListener('posture:signed', handler)
  }, [])
  ;(globalThis as unknown as { __postureUi?: unknown }).__postureUi = { setView, openSigned }
  if (view === 'metrics') return <div className="nl-shell"><main className="nl-page"><h1>体态指标</h1><PostureMetricsSettings store={session.store} /></main></div>
  if (view === 'signed') return <div className="nl-shell"><main className="nl-page"><h1>签字后的体态</h1><PostureSummary postures={signed} title="这次面诊的体态记录" /></main></div>
  return <PostureTool identity={session.identity} store={session.store} student={student} onClose={() => {}} />
}

createRoot(document.getElementById('root')!).render(<Harness />)

Object.assign(window, {
  __posture: {
    points,
    capture: async (view: 'front' | 'side' | 'video' = 'front') => {
      const input = document.querySelector('input[aria-label="拍摄或选择体态照片/视频"]') as HTMLInputElement
      const transfer = new DataTransfer(); transfer.items.add(await fakeImage())
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      void view
    },
    seed: async (count: number, markCount = 0) => {
      const metrics = await loadPostureMetrics(session.store)
      for (let index = 0; index < count; index += 1) {
        const marks = index < markCount ? [{ point: 'left_shoulder' as const, reason: '左肩高', source: 'teacher' as const }] : []
        const segment = newPostureSegment(frame('front'), '站立', 'before')
        segment.marks = marks
        const record = newPostureRecord(session.identity, student, [segment], metrics)
        record.at = new Date(Date.UTC(2026, 6 + index, 10)).toISOString()
        record.values = { [segment.id]: (await import('../domain/tcm/posture')).computeMetrics(segment, metrics) }
        await savePostureDraft(session.store, record)
      }
    },
    signAll: async () => {
      const { listPostureDrafts, deletePostureDraft } = await import('../app/src/core/posture')
      const drafts = await listPostureDrafts(session.store, student)
      const encounter = startInPersonEncounter({ teacher: session.identity.publicKey, student })
      encounter.postures = drafts
      const signedEvent = signEncounter(encounter, session.identity.privateKey)
      await saveTeacherRecord(session.store, signedEvent, session.identity.privateKey)
      for (const draft of drafts) await deletePostureDraft(session.store, draft.id)
      return signedEvent.id
    },
    openSigned: async () => {
      ;(globalThis as unknown as { __postureSigned: PostureRecord[] }).__postureSigned = await openSignedRecords()
      window.dispatchEvent(new Event('posture:signed'))
    },
    draftBytes: async () => {
      const { listPostureDrafts } = await import('../app/src/core/posture')
      return JSON.stringify(await listPostureDrafts(session.store, student))
    },
    storeName: 'v230-' + scene,
  },
})
