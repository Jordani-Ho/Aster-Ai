import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { Homework } from './core/record/types'
import { listReceivedRecords, type ReceivedRecord, type SendEnvelope } from './core/inbox'
import { loadVideo, type PracticeVideoRef } from './core/practice-video'
import { mediaBase, prepareAndUpload } from './core/practice-video/prepare'
import { listPracticeReviews, OUTGOING_COLLECTION, sendPractice, replyToPractice, type PracticeOutgoing, type PracticeReview } from './core/practice-video/review'
import './practice-video.css'

const message = (error: unknown) => error instanceof Error ? error.message : '未完成，请重试'
export function VideoCapture({ label, busy, onFile }: { label: string; busy: boolean; onFile: (file: File) => void }) {
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null)
  const selected = (input: HTMLInputElement) => { const file = input.files?.[0]; input.value = ''; if (file) onFile(file) }
  return <div className="video-capture"><button type="button" disabled={busy} onClick={() => camera.current?.click()}>{busy ? '正在处理视频…' : label}</button>
    <button type="button" disabled={busy} onClick={() => album.current?.click()}>从相册选视频</button>
    <input ref={camera} aria-label={label} type="file" accept="video/*" capture="environment" hidden onChange={e => selected(e.currentTarget)} />
    <input ref={album} aria-label="从相册选视频" type="file" accept="video/*" hidden onChange={e => selected(e.currentTarget)} />
    <small>单段不超过 3 分钟。只给这位学生使用。</small></div>
}

function useVideo(store: LocalStore, identity: Identity, ref: PracticeVideoRef | undefined, retry: number) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false, objectUrl = ''
    setUrl(''); setError('')
    if (ref) void loadVideo(store, mediaBase(), identity, ref, ref.context).then(bytes => {
      if (cancelled) { bytes.fill(0); return }
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mime }))
      bytes.fill(0); setUrl(objectUrl)
    }).catch(() => { if (!cancelled) setError('视频还在路上') })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [store, identity.publicKey, ref?.sha256, retry])
  return { url, error }
}

export function VideoPlayer({ store, identity, original, practice, onClose, onReady }: { store: LocalStore; identity: Identity; original: PracticeVideoRef; practice?: PracticeVideoRef; onClose: () => void; onReady?: (ready: boolean) => void }) {
  const [retry, setRetry] = useState(0), [slow, setSlow] = useState(false), [loop, setLoop] = useState(false), [audio, setAudio] = useState<'original' | 'practice'>('original'), [playing, setPlaying] = useState(false), [position, setPosition] = useState(0), [error, setError] = useState('')
  const a = useVideo(store, identity, original, retry), b = useVideo(store, identity, practice, retry)
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null), panel = useRef<HTMLDivElement>(null)
  const duration = Math.min(original.duration, practice?.duration ?? original.duration)
  const ready = !!a.url && (!practice || !!b.url)
  useEffect(() => { onReady?.(ready) }, [ready, onReady])
  const videos = () => [left.current, right.current].filter((v): v is HTMLVideoElement => !!v)
  const pause = () => { videos().forEach(v => v.pause()); setPlaying(false) }
  const seek = (time: number) => { videos().forEach(v => { v.currentTime = time }); setPosition(time) }
  const play = async () => {
    setError('')
    try {
      if ((left.current?.currentTime ?? 0) >= duration - .1) seek(0)
      videos().forEach(v => { v.playbackRate = slow ? .5 : 1; v.preservesPitch = true })
      await Promise.all(videos().map(v => v.play())); setPlaying(true)
    } catch { pause(); setError('暂时无法播放，请重试；也可以请老师换一段系统相机视频。') }
  }
  const finishCycle = () => {
    // An ended event queued before seek(0) must not restart a second playback cycle.
    if (videos().every(v => v.currentTime < duration - .05)) return
    pause()
    if (loop) { seek(0); void play() }
  }
  useEffect(() => { videos().forEach(v => { v.playbackRate = slow ? .5 : 1; v.preservesPitch = true }) }, [slow])
  return <div className={'video-overlay'+(onReady?' video-review':'')} role="dialog" aria-modal="true" aria-label={practice ? '并排对照视频' : '对照视频'} ref={panel}>
    <header><h2>{practice ? '并排对照' : '对照视频'}</h2><button onClick={() => { pause(); onClose() }}>关闭视频</button></header>
    {(!ready || a.error || b.error) && <div role="status"><p>{a.error || b.error || '正在准备视频…'}</p>{(a.error || b.error) && <><button onClick={() => setRetry(n => n + 1)}>重试下载</button><p>视频请从备份文件恢复，或请老师重发</p></>}</div>}
    <div className={practice ? 'video-pair' : 'video-single'}>
      <figure><figcaption>当初的视频</figcaption><video ref={left} src={a.url || undefined} playsInline preload="metadata" muted={audio !== 'original'} onTimeUpdate={() => {
        const v = left.current; if (!v) return
        setPosition(v.currentTime)
        if (right.current && Math.abs(right.current.currentTime - v.currentTime) > .2) right.current.currentTime = v.currentTime
        if (v.currentTime >= duration - .05) finishCycle()
      }} onEnded={finishCycle} onError={() => { if (a.url) setError('这台手机暂时无法播放此格式，请用系统相机重新录制。') }} /></figure>
      {practice && <figure><figcaption>今天的练习</figcaption><video ref={right} src={b.url || undefined} playsInline preload="metadata" muted={audio !== 'practice'} onEnded={finishCycle} onError={() => { if (b.url) setError('这台手机暂时无法播放此格式，请用系统相机重新录制。') }} /></figure>}
    </div>
    <div className="video-controls"><button disabled={!ready} onClick={() => playing ? pause() : void play()}>{playing ? '暂停' : practice ? '同步播放' : '播放视频'}</button>
      <label>进度<input aria-label="视频进度" type="range" min={0} max={duration} step={.1} value={position} onChange={e => seek(Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={slow} onChange={e => setSlow(e.target.checked)} />0.5 倍慢放（保留声音）</label>
      <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />循环播放</label>
      {practice && <label>听哪一段<select aria-label="听哪一段" value={audio} onChange={e => setAudio(e.target.value as typeof audio)}><option value="original">当初的视频</option><option value="practice">今天的练习</option></select></label>}
      <button onClick={() => { if (panel.current?.requestFullscreen) void panel.current.requestFullscreen().catch(() => {}); else (left.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.() }}>全屏播放</button>
    </div>{error && <p role="alert">{error}</p>}
  </div>
}

export function StudentHomeworkVideo({ homework, store, identity, fileIdentity, send }: { homework: Homework; store: LocalStore; identity: Identity; fileIdentity: Identity; send?: SendEnvelope }) {
  const [record, setRecord] = useState<ReceivedRecord>(), [outgoing, setOutgoing] = useState<PracticeOutgoing>(), [practice, setPractice] = useState<PracticeVideoRef>(), [view, setView] = useState<'original' | 'pair' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () => void Promise.all([listReceivedRecords(store, identity), store.list(OUTGOING_COLLECTION)]).then(([records, rows]) => {
      if (!active) return
      const current = records.find(r => r.encounter.plan.homework.some(h => h.id === homework.id && h.video?.sha256 === homework.video?.sha256))
      setRecord(current)
      const latest = rows.map(r => r.value as unknown as PracticeOutgoing).filter(r => r.homework === homework.id && r.original.sha256 === homework.video?.sha256).sort((a, b) => b.at.localeCompare(a.at))[0]
      setOutgoing(latest); if (latest) setPractice(previous => previous ?? latest.practice)
    }).catch(() => { if (active) setError('视频资料读取失败，请重试') })
    refresh(); window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store, identity.publicKey, homework.id, homework.video?.sha256, status])
  if (!homework.video || !record) return null
  const original = record.encounter.plan.homework.find(h => h.id === homework.id)!.video!
  const submit = async (ref: PracticeVideoRef) => {
    if (!send) throw Error('暂未连接社区，请稍后重试')
    await sendPractice(record, homework.id, ref, identity, fileIdentity, store, mediaBase(), send)
    setStatus('已发给老师，等老师回看。')
  }
  return <div className="homework-video"><button onClick={() => setView('original')}>对照视频</button>
    <p className="privacy-note">换手机时：视频请从备份文件恢复，或请老师重发</p>
    <p className="privacy-note">发给老师回看时，会一起交给老师当初的视频和这次练习。</p>
    <VideoCapture label="录一段我的练习" busy={busy} onFile={file => {
      setBusy(true); setError(''); setStatus('')
      void prepareAndUpload(file, { teacher: record.teacher, student: identity.publicKey, homework: homework.id, role: 'practice' }, store, fileIdentity, mediaBase()).then(async ref => { setPractice(ref); await submit(ref) }).catch(e => setError(message(e))).finally(() => setBusy(false))
    }} />
    {practice && <><button onClick={() => setView('pair')}>并排看看我的练习</button><button disabled={busy} onClick={() => { setBusy(true); setError(''); void submit(practice).catch(e => setError(message(e))).finally(() => setBusy(false)) }}>发给老师回看</button></>}
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}{outgoing?.reply && <p className="video-reply">老师回复：{outgoing.reply}</p>}
    {view && <VideoPlayer store={store} identity={fileIdentity} original={original} practice={view === 'pair' ? practice : undefined} onClose={() => setView(null)} />}
  </div>
}

export function TeacherPracticeInbox({ store, identity, send }: { store: LocalStore; identity: Identity; send: SendEnvelope }) {
  const [rows, setRows] = useState<PracticeReview[]>([]), [selected, setSelected] = useState<PracticeReview>(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reviewReady, setReviewReady] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => void listPracticeReviews(store).then(value => { if (active) setRows(value) }).catch(() => { if (active) setError('练习留言读取失败') })
    refresh(); window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store])
  return <section className="teacher-card"><h2>练习回看</h2>{!rows.length && <p>学生发来练习后，会出现在这里。</p>}
    {rows.map((row, i) => <article key={row.id}><p>{row.studentLabel || '学生'} · {row.homeworkTitle || '练习 ' + (i + 1)} · {new Date(row.receivedAt).toLocaleDateString()}</p><button onClick={() => { setReviewReady(false); setSelected(row); setText('') }}>并排回看练习</button></article>)}
    {selected && <><VideoPlayer key={selected.id} store={store} identity={identity} original={selected.original} practice={selected.practice} onReady={setReviewReady} onClose={() => setSelected(undefined)} />
      <form className="practice-reply-form" onSubmit={e => { e.preventDefault(); if(!reviewReady||busy)return; setBusy(true); setError(''); void replyToPractice(identity, store, selected.id, text, send).then(() => { setSelected(undefined); setRows(previous => previous.filter(r => r.id !== selected.id)); setText('') }).catch(e => setError(message(e))).finally(() => setBusy(false)) }}>
        <label>回一句话<textarea aria-label="练习回复" value={text} maxLength={2000} disabled={busy} onChange={e => setText(e.target.value)} /></label><button disabled={busy || !reviewReady || !text.trim()}>回复并交还视频</button><p>交还后，本机删除这次回看的两段视频。</p>
      </form></>}{error && <p role="alert">{error}</p>}
  </section>
}

export function WeeklyVideoReminder({ store, onOpen }: { store: LocalStore; onOpen: () => void }) {
  const [visible, setVisible] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all([store.list('homework'), store.get('settings', 'video-weekly-reminder')]).then(([rows, last]) => {
      const at = typeof last === 'string' ? Date.parse(last) : 0
      if (active) setVisible(rows.some(r => !!(r.value as unknown as { homework?: Homework }).homework?.video) && (!at || Date.now() - at >= 7 * 86400000))
    }).catch(() => {})
    return () => { active = false }
  }, [store])
  const dismiss = async () => { await store.put('settings', 'video-weekly-reminder', new Date().toISOString()); setVisible(false) }
  return visible ? <aside className="video-weekly"><p>录一段给老师看看有没有走样</p><button onClick={() => { void dismiss().then(onOpen).catch(() => setError('请重试')) }}>去录练习</button><button onClick={() => { void dismiss().catch(() => setError('请重试')) }}>这周先跳过</button>{error && <p role="alert">{error}</p>}</aside> : null
}
