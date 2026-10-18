import { useEffect, useState } from 'react'
import { recordPhotos, type ReceivedRecord } from './core/inbox'
import type { LocalStore } from './core/store'
export function RecordPhotos({ store, record }: { store: LocalStore; record: ReceivedRecord }) {
  const [urls, setUrls] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const created: string[] = []
    void recordPhotos(store, record).then(photos => {
      if (!active) return
      for (const photo of photos) created.push(URL.createObjectURL(new Blob([photo.data.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })))
      setUrls(created); setError('')
    }).catch(() => { if (active) setError('照片暂未能读取，请稍后重试。') })
    return () => { active = false; created.forEach(url => URL.revokeObjectURL(url)) }
  }, [store, record])
  const total = record.encounter.intake.attachments.filter(ref => ref.type === 'photo').length
  return <div><p>照片 {urls.length}/{total}{urls.length < total ? ' · 其余照片还在路上' : ''}</p>
    {error && <p role="status">{error}</p>}
    {urls.map((url, i) => <img key={url} src={url} alt={'病历照片 ' + (i + 1)} style={{ maxWidth: '100%', height: 'auto', borderRadius: 10 }} />)}
  </div>
}
