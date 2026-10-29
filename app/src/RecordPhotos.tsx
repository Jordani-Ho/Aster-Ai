import { useEffect, useState } from 'react'
import { recordPhotos, type ReceivedRecord } from './core/inbox'
import type { LocalStore } from './core/store'
export function RecordPhotos({ store, record }: { store: LocalStore; record: ReceivedRecord }) {
  const [urls, setUrls] = useState<{url:string;description:string}[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const created: string[] = []
    const tongueIds = new Set(record.encounter.intake.tongues?.flatMap(tongue => tongue.crop ? [tongue.crop.id] : []) ?? [])
    void recordPhotos(store, record).then(all => {
      const photos = all.filter(photo => !tongueIds.has(photo.ref.id))
      if (!active) return
      for (const photo of photos) created.push(URL.createObjectURL(new Blob([photo.data.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })))
      setUrls(photos.map((photo, index) => ({url:created[index],description:photo.ref.description ?? ''}))); setError('')
    }).catch(() => { if (active) setError('照片暂未能读取，请稍后重试。') })
    return () => { active = false; created.forEach(url => URL.revokeObjectURL(url)) }
  }, [store, record])
  const total = record.encounter.intake.attachments.filter(ref => ref.type === 'photo' && !record.encounter.intake.tongues?.some(tongue => tongue.crop?.id === ref.id)).length
  return <div><p>照片 {urls.length}/{total}{urls.length < total ? ' · 其余照片还在路上' : ''}</p>
    {error && <p role="status">{error}</p>}
    {urls.map(({url,description}, i) => <figure key={url}><img src={url} alt={'病历照片 ' + (i + 1)} style={{ maxWidth: '100%', height: 'auto', borderRadius: 10 }} />{description && <figcaption>{description}</figcaption>}</figure>)}
  </div>
}
