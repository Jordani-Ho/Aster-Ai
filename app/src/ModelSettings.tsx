import {useState} from 'react'
import type {LocalStore} from './core/store'
import {providers,ModelRequestError,normalizeModel,testConnection,savePersonalModel,connectionError,type PersonalModel,type ModelGateway} from './core/llm/personal'
import './newui.css'
import './newui2.css'
// V2-28：部署开了社区网关模型时，学生可以先不填 Key；建馆/接入页的底部按钮固定在视口底部（含安全区）。
export interface CommunityStart {
  available: boolean
  busy: boolean
  error: string
  onStart: () => void
}
export function ModelSettings({store,gateway,current,onSaved,initial=false,submitLabel,community}:{store:LocalStore;gateway:ModelGateway|null;current:PersonalModel|null;onSaved:(model:PersonalModel)=>void;initial?:boolean;submitLabel?:string;community?:CommunityStart}){
 const [provider,setProvider]=useState(current?.provider??providers[0]!.id)
 const selected=providers.find(p=>p.id===provider)!
 const [baseUrl,setBaseUrl]=useState(current?.baseUrl??selected.baseUrl),[model,setModel]=useState(current?.model??selected.model),[apiKey,setApiKey]=useState(''),[endpoint,setEndpoint]=useState(current?.provider==='doubao'?current.model:'')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[tested,setTested]=useState<PersonalModel|null>(null)
 const changed=()=>{setTested(null);setError('')}
 const select=(id:string)=>{const p=providers.find(p=>p.id===id)!;setProvider(id);setBaseUrl(p.baseUrl);setModel(p.model);setEndpoint('');setApiKey('');changed()}
 const test=async()=>{setBusy(true);changed();try{if(selected.endpointId&&!/^ep-[A-Za-z0-9-]+$/.test(endpoint.trim()))throw new ModelRequestError(400);const config=normalizeModel({provider,baseUrl,model:selected.endpointId?endpoint:model,apiKey:apiKey||(current?.provider===provider?current.apiKey:''),testedAt:''});await testConnection(config,gateway);setTested({...config,testedAt:new Date().toISOString()})}catch(cause){setError(connectionError(cause))}finally{setBusy(false)}}
 const save=async()=>{if(!tested||busy)return;setBusy(true);try{await savePersonalModel(store,tested);setApiKey('');onSaved(tested)}catch{setError('本机没有保存成功，请重试。')}finally{setBusy(false)}}
 const fields=<>
  <h2>{initial?(community?.available?'用自己的模型账户（可选）':'接入您的大模型'):'我的大模型'}</h2>
  <p>每个人接入自己的模型账户，费用由自己的账户承担。</p>
  <label>选择服务商<select aria-label="选择服务商" disabled={busy} value={provider} onChange={e=>select(e.target.value)}>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{' '}
  <a style={{whiteSpace:'nowrap',display:'inline-block'}} href={'/help/'+provider+'.html'} target="_blank" rel="noopener noreferrer">怎么申请？</a>
  <p><label>接入凭证<input type="password" disabled={busy} autoComplete="off" value={apiKey} placeholder={current?.provider===provider?'已保存；不更换可留空':'粘贴服务商提供的 API Key'} onChange={e=>{setApiKey(e.target.value);changed()}} style={{width:'100%',boxSizing:'border-box'}}/></label></p>
  {selected.endpointId&&<p><label>接入点 ID<input disabled={busy} value={endpoint} placeholder="ep-…" onChange={e=>{setEndpoint(e.target.value);changed()}}/></label></p>}
  <details open={provider==='other'}><summary>模型与地址</summary><p><label>接口地址<input disabled={busy} value={baseUrl} onChange={e=>{setBaseUrl(e.target.value);changed()}} style={{width:'100%',boxSizing:'border-box'}}/></label></p>{!selected.endpointId&&<p><label>模型名称<input disabled={busy} value={model} onChange={e=>{setModel(e.target.value);changed()}}/></label></p>}<p>使用按量计费的模型接口。账户地区与接口地址须匹配；不要填写聊天会员或编程套餐地址。</p></details>
  <p>整理时会将所需文字发给您选择的模型服务商；浏览器连接不上时，经社区网关转发，网关不保存凭证和内容。接入后调用失败，内测期间可能使用备用模型。</p>
  </>
 const buttons=<>
  {error&&<p role="alert">{error}</p>}{tested&&<p role="status">✓ 连接成功</p>}
  <button disabled={busy} onClick={()=>void test()}>{busy?'请稍候…':'测试连接'}</button>{tested&&<button disabled={busy} onClick={()=>void save()}>{initial?(submitLabel??'进入首页'):'保存接入'}</button>}
  </>
 const communityBlock=community?.available?<section aria-label="社区模型" className="model-community">
  <h2>先用社区模型开始</h2>
  <p>这个部署已经接好模型，可以直接开始，不用填自己的 Key。以后想换，再回这里填。</p>
  <button type="button" className="nl-primary" disabled={busy||community.busy} onClick={()=>community.onStart()}>{community.busy?'正在连接社区模型…':'先用社区模型开始'}</button>
  {community.error&&<p role="alert">{community.error}</p>}
  <p className="nl-quiet">或者，用自己的模型账户：</p>
 </section>:null
 if(!initial)return <section aria-label="模型接入" style={{maxWidth:480,margin:'0 auto'}}>{communityBlock}{fields}{buttons}</section>
 return <main className="model-start">
  <div className="model-start-body"><h1 className="model-start-title">知衡</h1>{communityBlock}{fields}</div>
  <footer className="model-start-foot">{buttons}</footer>
 </main>
}
