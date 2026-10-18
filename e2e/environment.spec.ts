import { test, expect, runtime } from './fixtures'
import { actors } from './actors.mjs'

test('two automatically generated contexts persist isolated identities without visible technical terms',async({people})=>{
 const keys:string[]=[]
 for(const person of [people.teacher,people.student]){
  expect(await person.page.locator('body').innerText()).not.toMatch(/密钥|公钥|npub|十六进制/)
  const key=()=>person.page.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return s.identity.publicKey}finally{s.store.close();s.identity.privateKey.fill(0)}})
  const first=await key();expect(first).toMatch(/^[0-9a-f]{64}$/);keys.push(first)
  await person.page.reload();await expect(person.page.getByRole('heading',{name:person===people.teacher?'今天':'镜子',exact:true})).toBeVisible()
  expect(await key()).toBe(first)
 }
 expect(keys[0]).not.toBe(keys[1])
})

test('real patched relay carries actual encrypted transport messages between authenticated identities', async ({ people }) => {
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
