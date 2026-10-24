import initial from './default.json'

export const TEMPLATE_TYPES = ['inquiry', 'record', 'treatment', 'prescription'] as const
export type TemplateType = typeof TEMPLATE_TYPES[number]
export const TEMPLATE_LABELS: Record<TemplateType, string> = { inquiry: '问诊', record: '病历', treatment: '施治', prescription: '开方' }
export type TemplateSchema = Record<string, any>
export const COOKING_METHODS = ['常规', '先煎', '后下', '包煎', '另煎', '烊化', '冲服'] as const
export function defaultSchema(type: TemplateType): TemplateSchema {
  if (type === 'inquiry') return { version: 1, fields: initial.focus.slice(0, 10).map((label, index) => ({ key: `question_${index}`, label, ask: label, order: index + 1, required: index === 0, answer_type: 'text', choices: [], follow_up: '' })) }
  if (type === 'record') return { version: 1, sections: [
    { key: 'intake', title: '主诉与既往', order: 1, writable_by: 'ai' },
    { key: 'fourExams', title: '四诊', order: 2, writable_by: 'ai' },
    { key: 'judgment', title: '判断', order: 3, writable_by: 'ai' },
    { key: 'plan', title: '处理', order: 4, writable_by: 'ai' },
    { key: 'confirmation', title: '老师核对签字', order: 5, writable_by: 'teacher' },
  ].map(item => ({ ...item, key: item.key === 'fourExams' ? 'four_exams' : item.key, hint: '', required: false })), tone: { style: '', forbidden: [] } }
  if (type === 'treatment') return { version: 1, format: 'text', content: '按本次问诊拟订调养方案，具体内容与用法由老师核对签发。', placeholders: [] }
  return { version: 1, herbs: [], formulas: [], defaults: { cooking_method: '常规', remote: false } }
}

/** 按旧版两档口径重写；只报告具体路径，不清洗非法值。未知字段保留但只作为资料。 */
export function validateSchema(type: TemplateType, value: unknown, publish = false): TemplateSchema {
  const fail = (path: string, message: string): never => { throw Error(`${TEMPLATE_LABELS[type] ?? '模板'} · ${path}：${message}`) }
  const obj = (v: unknown, path: string): TemplateSchema => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(path, '须为 JSON 对象')
    return v as TemplateSchema
  }
  if (!TEMPLATE_TYPES.includes(type)) fail('type', '未知模板类别')
  const schema = obj(value, 'schema')
  const scan = (v: unknown, path: string, seen = new Set<object>(), depth = 0) => {
    if (depth > 64 || typeof v === 'string' && v.length > 2000) fail(path, '内容过长（单项最多 2000 字）')
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return
    if (!v || typeof v !== 'object' || seen.has(v) || Reflect.ownKeys(v).some(key => typeof key === 'symbol')) fail(path, '须为有限 JSON 内容')
    if (!Array.isArray(v)) obj(v, path)
    const node = v as object
    seen.add(node)
    for (const [key, item] of Object.entries(node)) scan(item, `${path}.${key}`, seen, depth + 1)
    seen.delete(node)
  }
  scan(schema, 'schema')
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 65536) fail('schema', '模板最多 64 KB')
  const text = (v: unknown, path: string, max: number, required = false, nonempty = false) => {
    if (v === undefined || v === null) { if (required) fail(path, '必填'); return }
    if (typeof v !== 'string' || v.length > max || nonempty && !v.trim()) fail(path, `须为${nonempty ? '非空' : ''}文字，最多 ${max} 字`)
  }
  const list = (v: unknown, path: string, max: number, required = false): any[] => {
    if ((v === undefined || v === null) && !required) return []
    if (!Array.isArray(v) || v.length > max) fail(path, `须为列表，最多 ${max} 项`)
    return v as any[]
  }
  const integer = (v: unknown, path: string, required = true) => {
    if ((v === undefined || v === null) && !required) return
    if (!Number.isSafeInteger(v) || (v as number) < 1) fail(path, '须为大于零的整数')
  }
  const bool = (v: unknown, path: string) => { if (v !== undefined && v !== null && typeof v !== 'boolean') fail(path, '须为是或否') }
  const choice = (v: unknown, path: string, values: readonly unknown[]) => { if (v !== undefined && v !== null && !values.includes(v)) fail(path, `只能是 ${values.join(' / ')}`) }
  const unique = (rows: any[], fields: string[], path: string) => {
    for (const field of fields) {
      const seen = new Set<unknown>()
      rows.forEach((v, index) => {
        obj(v, `${path}[${index}]`)
        if (v[field] !== undefined && v[field] !== null) {
          if (seen.has(v[field])) fail(`${path}[${index}].${field}`, '不能重复')
          seen.add(v[field])
        }
      })
    }
  }
  if (schema.version !== undefined && schema.version !== null) integer(schema.version, 'version')
  if (schema.meta !== undefined && schema.meta !== null) obj(schema.meta, 'meta')
  if (type === 'inquiry' || type === 'record') {
    const inquiry = type === 'inquiry', key = inquiry ? 'fields' : 'sections'
    const rows = list(schema[key], key, inquiry ? 20 : 12, true)
    unique(rows, ['key', 'order'], key)
    rows.forEach((item, index) => {
      const path = `${key}[${index}]`
      if (typeof item.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(item.key)) fail(path + '.key', '须为小写字母开头的键名，最多 32 字符')
      text(item[inquiry ? 'label' : 'title'], path + (inquiry ? '.label' : '.title'), inquiry ? 16 : 20, true, true)
      integer(item.order, path + '.order'); bool(item.required, path + '.required')
      text(item[inquiry ? 'ask' : 'hint'], path + (inquiry ? '.ask' : '.hint'), 120)
      if (inquiry) {
        text(item.follow_up, path + '.follow_up', 120)
        choice(item.answer_type, path + '.answer_type', ['text', 'number', 'choice'])
        if (item.answer_type === 'choice') {
          const choices = list(item.choices, path + '.choices', 12, true)
          if (choices.length < 2 || new Set(choices).size !== choices.length) fail(path + '.choices', '须为 2–12 个不同选项')
          choices.forEach((v, n) => text(v, `${path}.choices[${n}]`, 2000, true, true))
        }
      } else choice(item.writable_by, path + '.writable_by', ['ai', 'teacher'])
    })
    if (publish && (rows.length < (inquiry ? 3 : 2) || !rows.some(item => inquiry ? item.required === true : item.writable_by === 'teacher'))) fail(key, inquiry ? '发布须至少 3 项，并有 1 项必问' : '发布须至少 2 段，并有 1 段留待老师')
    if (!inquiry && schema.tone !== undefined && schema.tone !== null) {
      const tone = obj(schema.tone, 'tone'); text(tone.style, 'tone.style', 120)
      list(tone.forbidden, 'tone.forbidden', 20).forEach((v, n) => text(v, `tone.forbidden[${n}]`, 2000, true, true))
    }
  } else if (type === 'treatment') {
    choice(schema.format, 'format', ['text']); text(schema.content, 'content', 2000, true, publish)
    list(schema.placeholders, 'placeholders', 8).forEach((v, n) => text(v, `placeholders[${n}]`, 60, true, true))
  } else {
    const herb = (item: any, path: string, amountKey: string) => {
      obj(item, path); text(item.herb_name, path + '.herb_name', 20, true, true)
      const amount = item[amountKey]
      if (amount !== undefined && amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1000)) fail(path + '.' + amountKey, '须为 0（未预填）或 0–1000 克')
      choice(item.role, path + '.role', ['', '君', '臣', '佐', '使']); choice(item.cooking_method, path + '.cooking_method', COOKING_METHODS)
    }
    const herbs = list(schema.herbs, 'herbs', 40); unique(herbs, ['herb_name', 'order'], 'herbs')
    herbs.forEach((item, index) => { herb(item, `herbs[${index}]`, 'default_amount'); integer(item.order, `herbs[${index}].order`, false) })
    const formulas = list(schema.formulas, 'formulas', 10); unique(formulas, ['name'], 'formulas')
    formulas.forEach((item, index) => {
      const path = `formulas[${index}]`; text(item.name, path + '.name', 20, true, true)
      const composition = list(item.composition, path + '.composition', 20); unique(composition, ['herb_name'], path + '.composition')
      composition.forEach((part, n) => herb(part, `${path}.composition[${n}]`, 'amount'))
    })
    if (schema.defaults !== undefined && schema.defaults !== null) {
      const defaults = obj(schema.defaults, 'defaults'); choice(defaults.cooking_method, 'defaults.cooking_method', COOKING_METHODS); bool(defaults.remote, 'defaults.remote')
    }
  }
  return structuredClone(schema)
}
