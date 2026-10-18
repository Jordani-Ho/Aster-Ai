import { test, expect, runtime } from './fixtures'
import type { Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

async function syntheticVideo(seconds: number, padded = false) {
  const small = await readFile(new URL('./fixtures/practice-' + seconds + 's.mp4', import.meta.url))
  if (!padded) return small
  // An ISO-BMFF free box pads an otherwise valid, playable MP4 to exactly 20 MiB.
  const free = Buffer.alloc(20 * 1024 * 1024 - small.length)
  free.writeUInt32BE(free.length); free.write('free', 4)
  return Buffer.concat([small, free])
}
async function becomeKnown(student: Page) {
  await student.evaluate(async relay => {
    const a = '/src/core/store/index.ts', b = '/src/core/record/in-person.ts', c = '/src/core/transport/index.ts', d = '/src/core/inbox/index.ts'
    const session = await (await import(a)).resumeStore(), teachers = await session.store.get('settings', 'teachers')
    const encounter = (await import(b)).startInPersonEncounter({ teacher: teachers[0], student: session.identity.publicKey })
    encounter.kind = 'remote_async'; encounter.intake.chiefComplaint = { value: 'SYNTHETIC_VIDEO_CONSULT', source: 'student' }
    const transport = (await import(c)).createTransport({ privateKey: session.identity.privateKey, relays: [relay], onMessage: () => {} })
    transport.start()
    try { await (await import(d)).sendConsultPackage((recipient: any, envelope: any) => transport.send(recipient, envelope), { encounter, history: [], attachments: [] }) }
    finally { transport.close(); session.store.close(); session.identity.privateKey.fill(0) }
  }, runtime.relayUrl)
}
async function openHomework(page: Page) {
  await page.getByRole('button', { name: '其他', exact: true }).click()
  await page.getByRole('button', { name: '今日作业', exact: true }).click()
}

test('M1-23b 60s/20MB real MP4: camera input, ciphertext service, handover erasure, synchronized review and reply', async ({ people }) => {
  test.setTimeout(180000)
  const teacher = people.teacher.page, student = people.student.page
  const original = await syntheticVideo(60, true), practice = await syntheticVideo(5)
  expect(original.length).toBe(20 * 1024 * 1024)
  await becomeKnown(student)
  await expect(teacher.locator('.teacher-count')).toContainText('1')
  await teacher.getByRole('button', { name: '面诊', exact: true }).click()
  await teacher.getByLabel('选择学生').selectOption(people.student.actor.pubkey)
  await teacher.getByRole('button', { name: '新建面诊病历', exact: true }).click()
  await teacher.getByRole('textbox').fill('SYNTHETIC_VIDEO_INTAKE')
  await teacher.getByRole('button', { name: '加入这一句', exact: true }).click()
  await teacher.getByRole('button', { name: '生成病历', exact: true }).click()
  // Exercise the original-file fallback, including a real 20MB encrypted transfer.
  await teacher.evaluate(() => { delete (window as any).VideoEncoder; delete (window as any).AudioEncoder })
  const capture = teacher.locator('input[type=file][accept="video/*"][capture]')
  await expect(capture).toHaveAttribute('capture', 'environment')
  await capture.setInputFiles({ name: 'synthetic-original.mp4', mimeType: 'video/mp4', buffer: original })
  await expect(teacher.getByText('练习视频已准备 · 60 秒', { exact: false })).toBeVisible({ timeout: 45000 })
  const ref = await teacher.evaluate(async () => {
    const p = '/src/core/store/index.ts', s = await (await import(p)).resumeStore()
    try { return (await s.store.list('practice-video-draft'))[0].value.plan.homework[0].video }
    finally { s.store.close(); s.identity.privateKey.fill(0) }
  })
  const disk = await readFile(path.join(runtime.mediaDirectory, ref.sha256))
  expect(disk.length).toBe(original.length + 16)
  expect(disk.subarray(4, 8).toString()).not.toBe('ftyp')
  expect(disk.equals(original)).toBe(false)
  const modelRequests: string[] = []
  teacher.on('request', request => { if (request.url().includes('/chat/completions')) modelRequests.push(request.postData() ?? '') })
  await teacher.getByRole('textbox', { name: '说说怎么改' }).fill('SYNTHETIC_REMOVE_HERB')
  await teacher.getByRole('button', { name: '按意见改稿', exact: true }).click()
  await expect(teacher.getByText('SYNTHETIC_KEEP SYNTHETIC_DOSE', { exact: true })).toBeVisible()
  await expect(teacher.getByText('练习视频已准备 · 60 秒', { exact: false })).toBeVisible()
  expect(modelRequests.join('')).not.toContain(ref.key)
  expect(modelRequests.join('')).not.toContain(ref.sha256)
  await teacher.getByRole('button', { name: '签字发出', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
  const erased = await teacher.evaluate(async () => {
    const p = '/src/core/store/index.ts', s = await (await import(p)).resumeStore()
    try { const out: any = {}; for (const c of ['practice-video-files', 'practice-video-index', 'practice-video-draft', 'practice-video-staged', 'pending-handover', 'case-book']) out[c] = await s.store.list(c); return out }
    finally { s.store.close(); s.identity.privateKey.fill(0) }
  })
  for (const collection of Object.keys(erased).filter(c => c !== 'case-book')) expect(erased[collection]).toEqual([])
  expect(JSON.stringify(erased)).not.toContain(ref.key)
  expect(JSON.stringify(erased)).not.toContain(ref.sha256)
  expect(await teacher.evaluate(async ref => {
    const p = '/src/core/store/index.ts', s = await (await import(p)).resumeStore()
    try {
      const archive = await s.store.exportEncrypted({ includeBinary: true })
      for (const row of archive.records) { const text = JSON.stringify(await s.store.get(row.c, row.k)); if (text.includes(ref.key) || text.includes(ref.sha256)) return true }
      return false
    } finally { s.store.close(); s.identity.privateKey.fill(0) }
  }, ref)).toBe(false)
  await openHomework(student)
  await student.route('**/media/' + ref.sha256, route => route.abort('failed'))
  await student.getByRole('button', { name: '对照视频', exact: true }).click()
  const player = student.getByRole('dialog', { name: '对照视频', exact: true })
  await expect(player.getByText('视频还在路上', { exact: true })).toBeVisible()
  await student.unroute('**/media/' + ref.sha256)
  const damaged = Buffer.from(disk); damaged[9] ^= 1
  await writeFile(path.join(runtime.mediaDirectory, ref.sha256), damaged)
  await player.getByRole('button', { name: '重试下载', exact: true }).click()
  await expect(player.getByText('视频还在路上', { exact: true })).toBeVisible()
  expect(await student.evaluate(async () => { const p = '/src/core/store/index.ts', s = await (await import(p)).resumeStore(); try { return (await s.store.list('practice-video-files')).length } finally { s.store.close(); s.identity.privateKey.fill(0) } })).toBe(0)
  await writeFile(path.join(runtime.mediaDirectory, ref.sha256), disk)
  await player.getByRole('button', { name: '重试下载', exact: true }).click()
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.readyState >= 2 && Math.round(v.duration) === 60)).toBe(true)
  await player.getByLabel('0.5 倍慢放（保留声音）').check()
  await player.getByRole('button', { name: '播放视频', exact: true }).click()
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.playbackRate === .5 && !v.muted)).toBe(true)
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) => (v.webkitAudioDecodedByteCount ?? 0) > 0)).toBe(true)
  await player.getByLabel('循环播放', { exact: true }).check()
  await player.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 59.95 })
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime < 2)).toBe(true)
  if (!process.env.CI) await student.screenshot({ path: 'docs/screenshots/practice-video-student-375.png' })
  await player.getByRole('button', { name: '关闭视频', exact: true }).click()
  await student.locator('input[type=file][accept="video/*"][capture]').setInputFiles({ name: 'synthetic-practice.mp4', mimeType: 'video/mp4', buffer: practice })
  await expect(student.getByText('已发给老师，等老师回看。', { exact: true })).toBeVisible({ timeout: 45000 })
  await student.getByRole('button', { name: '并排看看我的练习', exact: true }).click()
  await expect(student.getByRole('dialog').locator('video')).toHaveCount(2)
  await student.getByRole('button', { name: '关闭视频', exact: true }).click()
  await teacher.getByRole('button', { name: '远程', exact: true }).click()
  await teacher.getByRole('button', { name: '并排回看练习', exact: true }).click()
  const pair = teacher.getByRole('dialog', { name: '并排对照视频' })
  await expect.poll(() => pair.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.every(v => v.readyState >= 2))).toBe(true)
  await pair.getByRole('button', { name: '同步播放', exact: true }).click()
  await expect.poll(() => pair.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.every(v => !v.paused) && Math.abs(videos[0].currentTime - videos[1].currentTime) < .3)).toBe(true)
  await pair.getByLabel('0.5 倍慢放（保留声音）').check()
  await pair.getByLabel('循环播放', { exact: true }).check()
  await pair.getByLabel('听哪一段', { exact: true }).selectOption('practice')
  await pair.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.forEach(v => { v.currentTime = 4.95 }))
  await expect.poll(() => pair.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.every(v => !v.paused && v.playbackRate === .5 && v.currentTime < 2) && videos[0].muted && !videos[1].muted)).toBe(true)
  await expect(pair.getByText('当初的视频', { exact: true }).first()).toBeInViewport()
  await expect(pair.getByText('今天的练习', { exact: true }).first()).toBeInViewport()
  const frameTimes = await pair.locator('video').evaluateAll((videos: HTMLVideoElement[]) => Promise.all(videos.map(video => new Promise<number>(resolve => video.requestVideoFrameCallback((_at, metadata) => resolve(metadata.mediaTime))))))
  expect(Math.abs(frameTimes[0] - frameTimes[1])).toBeLessThanOrEqual(.6)
  if (!process.env.CI) await teacher.screenshot({ path: 'docs/screenshots/practice-video-teacher-375.png' })
  await teacher.getByLabel('练习回复', { exact: true }).fill('SYNTHETIC_VIDEO_REPLY')
  await teacher.getByRole('button', { name: '回复并交还视频', exact: true }).click()
  await expect(teacher.getByRole('dialog')).toHaveCount(0)
  await expect(student.getByText('老师回复：SYNTHETIC_VIDEO_REPLY', { exact: true })).toBeVisible()
  expect(await teacher.evaluate(async () => { const p = '/src/core/store/index.ts', s = await (await import(p)).resumeStore(); try { return (await s.store.list('practice-reviews')).length + (await s.store.list('practice-video-files')).length } finally { s.store.close(); s.identity.privateKey.fill(0) } })).toBe(0)
  await expect(student.locator('body')).not.toContainText(/转发给其他学生|存入动作库/)
})
