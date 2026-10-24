import { it, expect } from 'vitest'
import { defaultSchema, validateSchema, type TemplateType } from '../../../../domain/tcm/templates/schema'

const field = { key: 'sample', label: '合成项', order: 1 }
const section = { key: 'sample', title: '合成段', order: 1 }
const cases: [TemplateType, unknown, string][] = [
  ['unknown' as never, {}, 'type'], ['inquiry', null, 'schema'], ['inquiry', { fields: [], version: 0 }, 'version'],
  ['inquiry', { fields: [], meta: [] }, 'meta'], ['inquiry', { fields: 'bad' }, 'fields'],
  ['inquiry', { fields: Array(21).fill(field) }, 'fields'], ['inquiry', { fields: [null] }, 'fields'],
  ['inquiry', { fields: [field, field] }, 'key'], ['inquiry', { fields: [field, { ...field, key: 'other' }] }, 'order'],
  ...[{ key: 'Bad key' }, { label: '' }, { label: '字'.repeat(17) }, { order: 1.5 }, { required: 'yes' }, { ask: '字'.repeat(121) }, { follow_up: '字'.repeat(121) }, { answer_type: 'bad' }, { answer_type: 'choice', choices: ['一项'] }, { answer_type: 'choice', choices: ['重复', '重复'] }, { answer_type: 'choice', choices: ['好', ''] }].map(patch => ['inquiry', { fields: [{ ...field, ...patch }] }, Object.keys(patch).at(-1)!] as [TemplateType, unknown, string]),
  ['record', { sections: [] }, 'sections'],
  ...[{ key: '' }, { title: '' }, { title: '字'.repeat(21) }, { order: 0 }, { hint: '字'.repeat(121) }, { writable_by: 'robot' }].map(patch => ['record', { sections: [{ ...section, ...patch }] }, Object.keys(patch)[0]] as [TemplateType, unknown, string]),
  ['record', { ...defaultSchema('record'), tone: [] }, 'tone'],
  ['record', { ...defaultSchema('record'), tone: { style: '字'.repeat(121) } }, 'tone.style'],
  ['record', { ...defaultSchema('record'), tone: { forbidden: [''] } }, 'forbidden'],
  ['treatment', { content: '', format: 'blocks' }, 'format'], ['treatment', {}, 'content'],
  ['treatment', { content: '合成骨架', placeholders: Array(9).fill('合成') }, 'placeholders'],
  ['treatment', { content: '合成骨架', placeholders: ['字'.repeat(61)] }, 'placeholders'],
  ['treatment', { content: '字'.repeat(2001) }, 'content'],
  ...[{ herb_name: '' }, { default_amount: -1 }, { default_amount: 1001 }, { default_amount: true }, { role: '其他' }, { cooking_method: '坏' }, { order: -1 }].map(patch => ['prescription', { herbs: [{ herb_name: '合成药', ...patch }] }, Object.keys(patch)[0]] as [TemplateType, unknown, string]),
  ['prescription', { herbs: [{ herb_name: '合成药' }, { herb_name: '合成药' }] }, 'herb_name'],
  ['prescription', { herbs: Array(41).fill({ herb_name: '合成药' }) }, 'herbs'],
  ['prescription', { formulas: [{ name: '', composition: [] }] }, 'name'],
  ['prescription', { formulas: [{ name: '合成方', composition: [{ herb_name: '合成药', amount: -1 }] }] }, 'amount'],
  ['prescription', { formulas: [{ name: '合成方', composition: Array(21).fill({ herb_name: '合成药' }) }] }, 'composition'],
  ['prescription', { formulas: Array(11).fill({ name: '合成方' }) }, 'formulas'],
  ['prescription', { defaults: { remote: 'yes' } }, 'remote'], ['prescription', { defaults: { cooking_method: '坏' } }, 'cooking_method'],
]
it.each(cases)('发布拒绝坏输入 %s %j，定位到 %s', (type, schema, path) => expect(() => validateSchema(type, schema, true)).toThrow(path))
it('JSON 深度、有限数值、对象类型、大小与发布完整性；未知字段原样保留', () => {
  for (const bad of [NaN, Infinity, undefined, new Date(), () => {}, Symbol('bad')]) expect(() => validateSchema('prescription', { unknown: bad })).toThrow()
  const cycle: any = {}; cycle.self = cycle
  expect(() => validateSchema('prescription', cycle)).toThrow()
  expect(() => validateSchema('prescription', { unknown: Array(70).fill('x'.repeat(1000)) })).toThrow('64 KB')
  expect(() => validateSchema('record', { sections: [{ ...section, writable_by: 'ai' }, { ...section, key: 'other', order: 2, writable_by: 'ai' }] }, true)).toThrow('留待老师')
  expect(() => validateSchema('inquiry', { fields: Array.from({ length: 3 }, (_, n) => ({ ...field, key: 'item_' + n, order: n + 1, required: false })) }, true)).toThrow('必问')
  const schema = { ...defaultSchema('treatment'), unknown: { retained: true } }
  expect(validateSchema('treatment', schema, true)).toEqual(schema)
})
