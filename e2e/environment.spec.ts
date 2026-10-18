import { test, expect, runtime } from './fixtures'
import { actors } from './actors.mjs'

test('two automatically generated contexts persist isolated identities without visible technical terms',async({people})=>{
 for(const person of [people.teacher,people.student]){expect(await person.page.locator('body').innerText()).not.toMatch(/密钥|助记词|公钥|npub|十六进制/);await person.page.reload();await expect(person.page.getByRole('heading',{name:person===people.teacher?'今天':'镜子',exact:true})).toBeVisible();const key=await person.page.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return s.identity.publicKey}finally{s.store.close();s.identity.privateKey.fill(0)}});expect(key).toBe(person.actor.pubkey)}
})

test('real patched relay authenticates two members and carries actual encrypted transport messages', async ({ people }) => {
  for (const person of [people.teacher, people.student]) {
    await person.page.evaluate(async ({ key, relay }) => {
      const module = '/src/core/transport/index.ts'
      const { createTransport } = await import(module)
      const state = window as any
      state.e2eMessages = []; state.e2eStatuses = []
      state.e2eTransport = createTransport({ privateKey: Uint8Array.from(key), relays: [relay], onMessage: (message: unknown) => { state.e2eMessages.push(message) }, onStatus: (status: string) => { state.e2eStatuses.push(status) } })
      state.e2eTransport.start()
    }, { key: person.actor.key, relay: runtime.relayUrl })
    await expect.poll(() => person.page.evaluate(() => (window as any).e2eStatuses.includes('ready'))).toBe(true)
  }
  await people.teacher.page.evaluate(async recipient => {
    await (window as any).e2eTransport.send(recipient, { type: 'e2e.ping', version: 1, payload: 'SYNTHETIC_ENCRYPTED_PING' })
  }, actors.student.pubkey)
  await expect.poll(() => people.student.page.evaluate(() => (window as any).e2eMessages.map((m: any) => m.envelope.payload))).toContain('SYNTHETIC_ENCRYPTED_PING')
  await people.student.page.evaluate(async recipient => {
    await (window as any).e2eTransport.send(recipient, { type: 'e2e.pong', version: 1, payload: 'SYNTHETIC_ENCRYPTED_PONG' })
  }, actors.teacher.pubkey)
  await expect.poll(() => people.teacher.page.evaluate(() => (window as any).e2eMessages.map((m: any) => m.envelope.payload))).toContain('SYNTHETIC_ENCRYPTED_PONG')
  for (const person of [people.teacher, people.student]) await person.page.evaluate(() => (window as any).e2eTransport.close())
})
test.describe('closed-mode compatibility',()=>{
 test.use({communityOpen:false})
test('real relay rejects non-member AUTH instead of silently running as an open relay', async ({ people }) => {
  const accepted = await people.teacher.page.evaluate(async ({ key, relay }) => {
    const module = '/src/core/transport/index.ts'
    const { createTransport } = await import(module)
    return new Promise(resolve => {
      const transport = createTransport({ privateKey: Uint8Array.from(key), relays: [relay], onMessage: () => {}, onStatus: (status: string) => {
        if (status === 'ready' || status === 'rejected') { transport.close(); resolve(status === 'ready') }
      } })
      transport.start()
    })
  }, { key: actors.outsider.key, relay: runtime.relayUrl })
  expect(accepted).toBe(false)
})
})

test('backup policy permits own 30078 events and does not deliver them to the other member', async ({ people }) => {
  const id = await people.teacher.page.evaluate(async ({ phrase, relay }) => {
    const identityModule = '/src/core/identity/index.ts', relayModule = '/src/core/backup/relay.ts'
    const { restoreIdentity } = await import(identityModule)
    const { communityBackupRelay } = await import(relayModule)
    // Use the approved application's existing backup event constructor rather than a test relay.
    const backupModule = '/src/core/backup/index.ts'
    const { createBackupManager } = await import(backupModule)
    const storeModule = '/src/core/store/index.ts', { resumeStore } = await import(storeModule)
    const session = await resumeStore()
    const identity = restoreIdentity(phrase), channel = communityBackupRelay(identity, [relay])
    const manager = createBackupManager({ identity, store: session.store, relay: channel })
    try {
      await manager.backupNow()
      const entries = await channel.list(identity.publicKey)
      if (!entries.length || entries[0].kind !== 30078) throw Error('own backup not returned')
      return entries[0].id
    } finally { manager.close(); channel.close(); session.store.close() }
  }, { phrase: actors.teacher.phrase, relay: runtime.relayUrl })
  const probe = await people.student.page.evaluate(async ({ phrase, relay, teacher }) => {
    const identityModule = '/src/core/identity/index.ts', relayModule = '/src/core/backup/relay.ts'
    const { restoreIdentity } = await import(identityModule), { communityBackupRelay } = await import(relayModule)
    const identity = restoreIdentity(phrase)
    let queriedOtherOwner = false
    const channel = communityBackupRelay(identity, [relay], (url: string) => {
      const socket = new WebSocket(url), send = socket.send.bind(socket)
      // Keep the student's actual AUTH, but deliberately request the teacher's backups.
      socket.send = data => {
        const frame = JSON.parse(String(data))
        if (frame[0] === 'REQ') { frame[2].authors = [teacher]; queriedOtherOwner = true }
        send(JSON.stringify(frame))
      }
      return socket
    })
    try { return { ids: (await channel.list(identity.publicKey)).map((event: any) => event.id), queriedOtherOwner } }
    catch (error) {
      if (!(error instanceof Error) || error.message !== '备份中继拒绝读取') throw error
      return { ids: [], queriedOtherOwner }
    } finally { channel.close() }
  }, { phrase: actors.student.phrase, relay: runtime.relayUrl, teacher: actors.teacher.pubkey })
  expect(probe.queriedOtherOwner).toBe(true)
  expect(probe.ids).toEqual([])
  expect(probe.ids).not.toContain(id)
})
test('browser reaches the actual signed gateway through same-origin proxy and receives local synthetic output', async ({ people }) => {
  const result = await people.teacher.page.evaluate(async key => {
    const module = '/src/core/llm/nip98.ts', { nip98Authorization } = await import(module)
    const url = location.origin + '/v1/chat/completions'
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'SYNTHETIC_INPUT_ONLY' }] })
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: await nip98Authorization(Uint8Array.from(key), url, 'POST', body) }, body })
    return { status: response.status, body: await response.json() }
  }, actors.teacher.key)
  expect(result.status).toBe(200)
  expect(JSON.parse(result.body.choices[0].message.content).judgment.symptomSummary.value).toBe('SYNTHETIC_SUMMARY')
})
