import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { readFileSync } from 'node:fs'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { createRunner } from './runner'
import { defineTask } from './tasks'
import { loadAgentRole } from './role'
import { assertAgentOutput, sendAgentMessage } from './guard'

const student = 'a'.repeat(64), teacher = 'b'.repeat(64)
const now = new Date(2026, 9, 24, 9)
async function session() { return openStore(createIdentity(), { factory: new IDBFactory() }) }
const job = (overrides: Record<string, unknown> = {}) => defineTask({
  id: 'sample', side: 'teacher' as const, trigger: { kind: 'manual' as const }, confirm: 'human' as const,
  gather: vi.fn(async () => ({ text: 'SYNTHETIC' })), run: vi.fn(async (data: { text: string }) => ({ text: data.text })),
  deliver: vi.fn(async () => {}), ...overrides,
})

describe('V2-21 任务与输入边界', () => {
  it('串行执行；同一对象同一天三次只生成一次，新的执行器也返回已存结果', async () => {
    const store = await session()
    try {
      const task = job(), runner = createRunner({ store, side: 'teacher', maxTokens: 100 })
      const request = { targetId: student, now }
      const results = await Promise.all([runner.run(task, request), runner.run(task, request), createRunner({ store, side: 'teacher', maxTokens: 100 }).run(task, request)])
      expect(task.run).toHaveBeenCalledOnce(); expect(task.gather).toHaveBeenCalledOnce()
      expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2])
      results[0].output.text = 'mutated'
      expect((await runner.run(task, request)).output.text).toBe('SYNTHETIC')
      expect(task.deliver).not.toHaveBeenCalled()
      await runner.confirm(task, request); await runner.confirm(task, request)
      expect(task.deliver).toHaveBeenCalledOnce()
    } finally { store.close() }
  })
  it('两件事没有共享材料；失败后不锁死队列，日志只有类别没有错误或材料原文', async () => {
    const store = await session()
    try {
      const runner = createRunner({ store, side: 'teacher', maxTokens: 100 })
      await expect(runner.run(job({ run: async () => { throw Error('SYNTHETIC_PRIVATE_REPLY') } }), { targetId: student, now })).rejects.toThrow('执行')
      const second = job({ gather: async () => ({ text: 'SECOND_ONLY' }) })
      expect((await runner.run(second, { targetId: teacher, now })).output).toEqual({ text: 'SECOND_ONLY' })
      const rows = await store.list('agent-failures')
      expect(rows).toHaveLength(1); expect(Object.keys(rows[0].value as object).sort()).toEqual(['at', 'kind'])
      expect(JSON.stringify(rows)).not.toContain('PRIVATE'); expect(JSON.stringify(rows)).not.toContain(student)
    } finally { store.close() }
  })
  it('预算过量在 run 之前拒绝；无模型的规则任务正常运行', async () => {
    const store = await session()
    try {
      const task = job({ gather: async () => ({ text: '字'.repeat(101) }) })
      const runner = createRunner({ store, side: 'teacher', maxTokens: 100 })
      await expect(runner.run(task, { targetId: student, now })).rejects.toThrow('材料')
      expect(task.run).not.toHaveBeenCalled()
      const automatic = job({ id: 'local', confirm: 'template' })
      expect((await runner.run(automatic, { targetId: student, now })).status).toBe('delivered')
    } finally { store.close() }
  })
  it.each([
    { id: '' }, { id: 'a'.repeat(65) }, { side: 'admin' }, { confirm: 'automatic' },
    { trigger: { kind: 'unknown' } }, { trigger: { kind: 'time', hour: 24 } },
    { trigger: { kind: 'time', hour: 1.5 } }, { trigger: { kind: 'message', type: '' } },
    { gather: null }, { run: null }, { deliver: null }, { tokens: 1 },
  ])('拒绝错误的任务定义 %j', value => expect(() => job(value)).toThrow())
  it.each([0, -1, NaN, Infinity, 1.5])('拒绝错误的额度 %s', async maxTokens => {
    const store = await session()
    try { expect(() => createRunner({ store, side: 'teacher', maxTokens })).toThrow() } finally { store.close() }
  })
  it('对象、日期、角色与自定义估算值校验；未产草稿不能确认', async () => {
    const store = await session()
    try {
      const runner = createRunner({ store, side: 'teacher', maxTokens: 100 })
      for (const targetId of ['', '含姓名', 'a'.repeat(129)]) await expect(runner.run(job(), { targetId, now })).rejects.toThrow()
      await expect(runner.run(job(), { targetId: student, now: new Date(NaN) })).rejects.toThrow()
      await expect(runner.run(job({ side: 'student' }), { targetId: student, now })).rejects.toThrow()
      await expect(runner.run(job({ tokens: () => NaN }), { targetId: student, now })).rejects.toThrow()
      await expect(runner.confirm(job(), { targetId: student, now })).rejects.toThrow()
      expect(() => createRunner({ store, side: 'admin' as never, maxTokens: 100 })).toThrow()
    } finally { store.close() }
  })
})

describe('守线与角色', () => {
  it('非师生不能发；同任务同人至少两小时，跨日也不绕过；人工草稿不自动发', async () => {
    const store = await session(), send = vi.fn(async (_recipient: string, _payload: unknown) => {})
    try {
      await expect(sendAgentMessage(store, 'teacher', 'invite', student, {}, now, send)).rejects.toThrow('关系')
      await store.put('teacher-students', student, { student })
      await sendAgentMessage(store, 'teacher', 'invite', student, {}, now, send)
      await expect(sendAgentMessage(store, 'teacher', 'invite', student, {}, new Date(+now + 7199999), send)).rejects.toThrow('时辰')
      await sendAgentMessage(store, 'teacher', 'invite', student, {}, new Date(+now + 7200000), send)
      expect(send).toHaveBeenCalledTimes(2)
      await store.put('settings', 'teachers', [teacher])
      await sendAgentMessage(store, 'student', 'reply', teacher, {}, now, send)
      const task = job({ deliver: async (output: unknown, context: { send: typeof send }) => context.send(student, output) })
      const runner = createRunner({ store, side: 'teacher', maxTokens: 100, send })
      await runner.run(task, { targetId: student, now }); expect(send).toHaveBeenCalledTimes(3)
      await runner.confirm(task, { targetId: student, now }); expect(send).toHaveBeenCalledTimes(4)
      await runner.confirm(task, { targetId: student, now }); expect(send).toHaveBeenCalledTimes(4)
    } finally { store.close() }
  })
  it.each([{ nested: [{ value: 'forged', source: 'teacher' }] }, { value: NaN }, { value: undefined }, new Date(), { value: Infinity }])('拒绝冒充老师及非 JSON 产出 %j', value => expect(() => assertAgentOutput(value)).toThrow())
  it('循环产出被拒；规则任务也过守线；模板任务向外发须获基础配置允许', async () => {
    const value: any = {}; value.self = value; expect(() => assertAgentOutput(value)).toThrow()
    const store = await session(), send = vi.fn(async (_recipient: string, _payload: unknown) => {})
    try {
      const runner = createRunner({ store, side: 'teacher', maxTokens: 100, send })
      await expect(runner.run(job({ run: async () => ({ source: 'teacher' }) }), { targetId: student, now })).rejects.toThrow()
      await store.put('teacher-students', student, { student })
      await expect(runner.run(job({ id: 'auto', confirm: 'template', deliver: async (_output: unknown, context: { send: typeof send }) => context.send(student, {}) }), { targetId: student, now })).rejects.toThrow('模板')
      expect(send).not.toHaveBeenCalled()
    } finally { store.close() }
  })
  it('角色缺项给默认和缺项清单；非法设置不默默变成有效配置', async () => {
    const store = await session()
    try {
      const role = await loadAgentRole(store, teacher, 'teacher')
      expect(role.side).toBe('teacher'); expect(role.invitation).toBe('review'); expect(role.template).toBeNull(); expect(role.missing).toContain('teacher-template')
      await store.put('settings', 'teachers', [teacher]); await store.put('settings', 'active-teacher', teacher)
      const studentRole = await loadAgentRole(store, student, 'student')
      expect(studentRole.currentTeacher).toBe(teacher); expect(studentRole.routine).toBeNull()
      await store.put('settings', 'invitation-mode', 'anything')
      await expect(loadAgentRole(store, teacher, 'teacher')).rejects.toThrow()
      await expect(loadAgentRole(store, 'bad', 'teacher')).rejects.toThrow()
      await expect(loadAgentRole(store, teacher, 'admin' as never)).rejects.toThrow()
    } finally { store.close() }
  })
  it('签字、入账、退款模块不 import agent；agent 不 import 领域、模型或签字工具', () => {
    for (const file of ['record/sign.ts', 'record/in-person.ts', 'ledger/money.ts', 'ledger/sync.ts', 'careplan/issue.ts', 'inbox/index.ts']) {
      expect(readFileSync(new URL('../' + file, import.meta.url), 'utf8')).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*agent/)
    }
    for (const file of ['runner.ts', 'tasks.ts', 'guard.ts', 'role.ts']) {
      expect(readFileSync(new URL('./' + file, import.meta.url), 'utf8')).not.toMatch(/from ['"][^'"]*(?:domain|prompts|drafting|llm|record\/sign|ledger)/)
    }
  })
  it('角色设置逐项校验；正常消息/定时触发可登记；额度估算不接受负数、小数或无限', async () => {
    const store = await session()
    try {
      for (const [key, value, agentSide] of [
        ['role', { role: 'admin' }, 'teacher'], ['role', null, 'teacher'],
        ['teacher-template', [], 'teacher'], ['teachers', ['bad'], 'student'],
        ['active-teacher', 'bad', 'student'], ['active-teacher', teacher, 'student'], ['agent-routine', [], 'student'],
      ] as const) {
        await store.put('settings', key, value as never)
        await expect(loadAgentRole(store, student, agentSide)).rejects.toThrow()
        await store.delete('settings', key)
      }
      await store.put('settings', 'teacher-template', { name: 'SYNTHETIC_TEMPLATE' })
      await store.put('settings', 'invitation-mode', 'auto')
      expect((await loadAgentRole(store, teacher, 'teacher')).invitation).toBe('auto')
      expect(job({ trigger: { kind: 'time', hour: 23 } }).trigger.kind).toBe('time')
      expect(job({ trigger: { kind: 'message', type: 'intake.ready' } }).trigger.kind).toBe('message')
      for (const value of [-1, 1.5, Infinity]) await expect(createRunner({ store, side: 'teacher', maxTokens: 100 }).run(job({ tokens: () => value }), { targetId: student, now })).rejects.toThrow()
    } finally { store.close() }
  })
  it('存储失败不冒充成功；模板允许时也过关系与冷却；发送失败不立即连发', async () => {
    const store = await session(), send = vi.fn(async (_recipient: string, _payload: unknown) => {})
    try {
      const realPut = store.put.bind(store)
      const spy = vi.spyOn(store, 'put').mockImplementation(async (collection, key, value) => {
        if (collection === 'agent-runs') throw Error('PRIVATE_DISK_ERROR')
        await realPut(collection, key, value)
      })
      const failed = job()
      await expect(createRunner({ store, side: 'teacher', maxTokens: 100 }).run(failed, { targetId: student, now })).rejects.toThrow('保存')
      expect(failed.deliver).not.toHaveBeenCalled(); expect(JSON.stringify(await store.list('agent-failures'))).not.toContain('PRIVATE')
      spy.mockRestore()
      await store.put('teacher-students', student, { student })
      const automatic = job({ id: 'permitted', confirm: 'template', deliver: async (_output: unknown, context: { send: typeof send }) => context.send(student, {}) })
      await createRunner({ store, side: 'teacher', maxTokens: 100, send, allowTemplate: async () => true }).run(automatic, { targetId: student, now })
      expect(send).toHaveBeenCalledOnce()
      const broken = vi.fn(async () => { throw Error('PRIVATE_NETWORK') })
      await expect(sendAgentMessage(store, 'teacher', 'failed-send', student, {}, now, broken)).rejects.toThrow()
      await expect(sendAgentMessage(store, 'teacher', 'failed-send', student, {}, now, broken)).rejects.toThrow('时辰')
      expect(broken).toHaveBeenCalledOnce()
      for (const recipient of ['', 'not-a-key']) await expect(sendAgentMessage(store, 'teacher', 'test', recipient, {}, now, send)).rejects.toThrow()
      await expect(sendAgentMessage(store, 'teacher', 'bad id', student, {}, now, send)).rejects.toThrow()
      await expect(sendAgentMessage(store, 'teacher', 'test', student, {}, new Date(NaN), send)).rejects.toThrow()
      await expect(sendAgentMessage(store, 'teacher', 'test', student, { source: 'teacher' }, now, send)).rejects.toThrow()
    } finally { store.close() }
  })
})
