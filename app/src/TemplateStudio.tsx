import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { loadTemplates, publishTemplate, saveTemplateDraft, type TemplateVersion } from './core/templates'
import { TEMPLATE_LABELS, TEMPLATE_TYPES, COOKING_METHODS, defaultSchema, type TemplateSchema, type TemplateType } from '../../domain/tcm/templates/schema'

export function TemplateStudio({ store, onSaved }: { store: LocalStore; onSaved?: () => void }) {
  const [type, setType] = useState<TemplateType>('inquiry'), [rows, setRows] = useState<TemplateVersion[]>([])
  const [schema, setSchema] = useState<TemplateSchema>(defaultSchema('inquiry')), [name, setName] = useState('问诊模板')
  const [source, setSource] = useState<TemplateVersion | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [dirty, setDirty] = useState(false)
  const select = (next: TemplateType, versions = rows) => {
    const row = versions.find(item => item.type === next && item.status === 'draft') ?? versions.find(item => item.type === next && item.status === 'active')
    setType(next); setSource(row ?? null); setSchema(structuredClone(row?.schema ?? defaultSchema(next))); setName(row?.name ?? `${TEMPLATE_LABELS[next]}模板`); setDirty(false); setNotice('')
  }
  useEffect(() => { void loadTemplates(store).then(next => { setRows(next); select('inquiry', next) }).catch(cause => setNotice(String(cause.message))) }, [store])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  const edit = (patch: TemplateSchema) => { setSchema(current => ({ ...current, ...patch })); setDirty(true); setNotice('') }
  const save = async (publish: boolean) => {
    setBusy(true); setNotice('')
    try {
      const draft = await saveTemplateDraft(store, type, name, schema, source?.id)
      if (publish) await publishTemplate(store, draft.id)
      const next = await loadTemplates(store); setRows(next); select(type, next)
      setNotice(publish ? '已发布，新起草使用这一版；旧版已归档。' : '草稿已保存，还未生效。')
      window.dispatchEvent(new Event('aster:data-changed')); onSaved?.()
    } catch (cause) { setNotice(`没保存成功：${cause instanceof Error ? cause.message : '请重试'}`) }
    finally { setBusy(false) }
  }
  const key = type === 'inquiry' ? 'fields' : 'sections'
  const items: TemplateSchema[] = schema[key] ?? []
  const editItem = (index: number, patch: TemplateSchema) => edit({ [key]: items.map((item, n) => n === index ? { ...item, ...patch } : item) })
  return <section aria-label="四类模板工作室" className="ground-templates">
    <div className="ground-tabs">{TEMPLATE_TYPES.map(item => <button type="button" key={item} aria-pressed={type === item} disabled={busy} onClick={() => { if (!dirty || confirm('修改还没保存，要放下这次修改吗？')) select(item) }}>{TEMPLATE_LABELS[item]}</button>)}</div>
    <p className="nl-quiet">{source ? `第 ${source.version} 版 · ${source.status === 'active' ? '生效中，保存修改会派生新版' : source.status === 'draft' ? '草稿，尚未生效' : '已归档'}` : '默认骨架，尚未发布'}</p>
    <label>模板名称<input value={name} maxLength={100} onChange={event => { setName(event.target.value); setDirty(true) }} /></label>
    {(type === 'inquiry' || type === 'record') && <>
      {items.map((item, index) => <fieldset key={index}><legend>{index + 1}. {item.label ?? item.title ?? '新项'}</legend>
        <label>{type === 'inquiry' ? '名称' : '段落标题'}<input value={item.label ?? item.title ?? ''} onChange={e => editItem(index, { [type === 'inquiry' ? 'label' : 'title']: e.target.value })} /></label>
        <label>{type === 'inquiry' ? '怎么问' : '整理要点'}<textarea value={item.ask ?? item.hint ?? ''} onChange={e => editItem(index, { [type === 'inquiry' ? 'ask' : 'hint']: e.target.value })} /></label>
        {type === 'inquiry' ? <>
          <label><input type="checkbox" checked={!!item.required} onChange={e => editItem(index, { required: e.target.checked })} />必问</label>
          <label>回答方式<select value={item.answer_type ?? 'text'} onChange={e => editItem(index, { answer_type: e.target.value })}><option value="text">说一说</option><option value="number">数字</option><option value="choice">选项</option></select></label>
          {item.answer_type === 'choice' && <label>选项（每行一项）<textarea value={(item.choices ?? []).join('\n')} onChange={e => editItem(index, { choices: e.target.value.split('\n') })} /></label>}
          <label>追问一句<input value={item.follow_up ?? ''} onChange={e => editItem(index, { follow_up: e.target.value })} /></label>
        </> : <label>这一段谁来写<select value={item.writable_by ?? 'ai'} onChange={e => editItem(index, { writable_by: e.target.value })}><option value="ai">智能体起草，老师核对</option><option value="teacher">留待老师</option></select></label>}
        <div className="ground-actions"><button type="button" disabled={index === 0} onClick={() => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; edit({ [key]: next.map((v, n) => ({ ...v, order: n + 1 })) }) }}>上移</button><button type="button" onClick={() => edit({ [key]: items.filter((_, n) => n !== index).map((v, n) => ({ ...v, order: n + 1 })) })}>删除这一项</button></div>
      </fieldset>)}
      <button type="button" onClick={() => edit({ [key]: [...items, { key: `item_${crypto.randomUUID().slice(0, 8)}`, [type === 'inquiry' ? 'label' : 'title']: '新项', order: items.length + 1, ...(type === 'inquiry' ? { ask: '', answer_type: 'text', required: false } : { hint: '', writable_by: 'ai' }) }] })}>添加{type === 'inquiry' ? '问题' : '段落'}</button>
      {type === 'record' && <label>语气与习惯<textarea value={schema.tone?.style ?? ''} onChange={e => edit({ tone: { ...schema.tone, style: e.target.value } })} /></label>}
    </>}
    {type === 'treatment' && <label>施治方案骨架<textarea rows={6} value={schema.content ?? ''} onChange={e => edit({ content: e.target.value })} /></label>}
    {type === 'prescription' && <>
      <p className="nl-quiet">默认不预填药名和剂量；每次开方由老师核对。</p>
      <label>默认煎法<select value={schema.defaults?.cooking_method ?? '常规'} onChange={e => edit({ defaults: { ...schema.defaults, cooking_method: e.target.value } })}>{COOKING_METHODS.map(method => <option key={method}>{method}</option>)}</select></label>
      {(schema.herbs ?? []).map((herb: TemplateSchema, index: number) => <fieldset key={index}><legend>常用药 {index + 1}</legend>
        <label>药名<input value={herb.herb_name} onChange={e => edit({ herbs: schema.herbs.map((v: TemplateSchema, n: number) => n === index ? { ...v, herb_name: e.target.value } : v) })} /></label>
        <label>预填克数（0 为不预填）<input type="number" min="0" max="1000" value={herb.default_amount ?? 0} onChange={e => edit({ herbs: schema.herbs.map((v: TemplateSchema, n: number) => n === index ? { ...v, default_amount: Number(e.target.value) } : v) })} /></label>
        <button type="button" onClick={() => edit({ herbs: schema.herbs.filter((_: unknown, n: number) => n !== index) })}>删除这味药</button>
      </fieldset>)}
      <button type="button" onClick={() => edit({ herbs: [...(schema.herbs ?? []), { herb_name: '', default_amount: 0 }] })}>添加常用药</button>
    </>}
    <div className="ground-actions"><button type="button" disabled={busy} onClick={() => void save(false)}>存为草稿</button><button type="button" disabled={busy} onClick={() => void save(true)}>发布这一版</button></div>
    {notice && <p role="status">{notice}</p>}
    <details><summary>版本记录</summary>{rows.filter(row => row.type === type).map(row => <p key={row.id}>第 {row.version} 版 · {row.name} · {row.status === 'active' ? '生效' : row.status === 'draft' ? '草稿' : '归档'}{row.parentId && `（承接第 ${rows.find(parent => parent.id === row.parentId)?.version} 版）`}</p>)}</details>
  </section>
}
