import table from './tongue-features.json'
export interface TongueAbstract {kind:'tongue';features:TongueFeatures;svg:string;shichen:string;jieqi:string;city:string}
export function tongueSummary(features:TongueFeatures):string {
 const f=parseTongueFeatures(features),label=(key:keyof typeof table.labels)=>table.labels[key]
 const marks=(items:string[]|null)=>items===null?'未知':items.length?'有':'未见'
 return `舌色：${label(f.color)}；苔色：${label(f.coatingColor)}；苔厚薄：${label(f.coatingThickness)}；舌形：${label(f.shape)}；齿痕：${marks(f.teeth)}；裂纹：${marks(f.cracks)}；读取置信度：${Math.round(f.confidence*100)}%`
}
export function parseTongueAbstract(value:unknown):TongueAbstract {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('舌象记录无效')
 const v=value as Record<string,unknown>
 if(Object.keys(v).sort().join(',')!=='city,features,jieqi,kind,shichen,svg'||v.kind!=='tongue')throw Error('舌象记录字段无效')
 for(const key of ['shichen','jieqi','city'])if(typeof v[key]!=='string'||!v[key].trim()||v[key].length>80||/[<>\r\n]|data:|https?:/i.test(v[key]))throw Error('舌象时地无效')
 const features=parseTongueFeatures(v.features),svg=tongueSvg(features)
 if(v.svg!==svg)throw Error('舌象示意图无效')
 return {kind:'tongue',features,svg,shichen:v.shichen as string,jieqi:v.jieqi as string,city:v.city as string}
}
export interface TongueFeatures {
 color:keyof typeof table.color
 coatingColor:keyof typeof table.coatingColor
 coatingThickness:keyof typeof table.coatingThickness
 shape:keyof typeof table.shape
 teeth:(typeof table.teeth[number])[]|null
 cracks:(typeof table.cracks[number])[]|null
 confidence:number
}
function member(value:unknown, values:object):boolean {return typeof value==='string'&&Object.hasOwn(values,value)}
function marks(value:unknown, allowed:readonly string[]):string[]|null {
 if(value===null)return null
 if(!Array.isArray(value)||value.length>allowed.length||value.some(v=>typeof v!=='string'||!allowed.includes(v))||new Set(value).size!==value.length)throw Error('标记无效')
 return allowed.filter(v=>value.includes(v))
}
export function parseTongueFeatures(value:unknown):TongueFeatures {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('特征无效')
 const v=value as Record<string,unknown>
 const keys=['color','coatingColor','coatingThickness','shape','teeth','cracks','confidence']
 if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw Error('特征字段无效')
 if(!member(v.color,table.color)||!member(v.coatingColor,table.coatingColor)||!member(v.coatingThickness,table.coatingThickness)||!member(v.shape,table.shape)||typeof v.confidence!=='number'||!Number.isFinite(v.confidence)||v.confidence<table.confidence.min||v.confidence>table.confidence.max)throw Error('特征取值无效')
 return {color:v.color,coatingColor:v.coatingColor,coatingThickness:v.coatingThickness,shape:v.shape,teeth:marks(v.teeth,table.teeth),cracks:marks(v.cracks,table.cracks),confidence:v.confidence} as TongueFeatures
}
// 固定模板，所有路径和调色来自代码/取值表，绝不使用模型 SVG、照片像素或任意字符串。
export function tongueSvg(input:unknown):string {
 const f=parseTongueFeatures(input)
 const teeth:Record<string,[number,number]>={'left-back':[48,85],'left-middle':[44,120],'left-tip':[56,155],'right-back':[152,85],'right-middle':[156,120],'right-tip':[144,155]}
 const cracks:Record<string,string>={back:'M100 62l-4 14 6 8',center:'M100 95l-6 15 8 13-3 13',tip:'M99 147l5 12-5 15',left:'M72 104l8 13-7 14',right:'M127 104l-8 13 7 14'}
 const marks=(f.teeth??[]).map(k=>{const [x,y]=teeth[k];return '<ellipse cx="'+x+'" cy="'+y+'" rx="6" ry="10" fill="#fffaf3"/>'}).join('')
 const lines=(f.cracks??[]).map(k=>'<path d="'+cracks[k]+'" fill="none" stroke="#783b46" stroke-width="2"/>').join('')
 const unknown=[f.color,f.coatingColor,f.coatingThickness,f.shape].includes('unknown')||f.teeth===null||f.cracks===null
 return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" role="img" aria-label="抽象舌形示意图"><title>外观示意'+(unknown?'（部分未知）':'')+'</title><rect width="200" height="240" fill="#fffaf3"/><g transform="translate(100 0) scale('+table.shape[f.shape]+' 1) translate(-100 0)"><path d="M58 40Q100 24 142 40C160 60 165 110 150 156Q132 202 100 211Q68 202 50 156C35 110 40 60 58 40Z" fill="'+table.color[f.color]+'" stroke="#805760" stroke-width="2"/><path d="M66 51Q100 39 134 51C145 77 148 109 136 146Q120 178 100 186Q80 178 64 146C52 109 55 77 66 51Z" fill="'+table.coatingColor[f.coatingColor]+'" opacity="'+table.coatingThickness[f.coatingThickness]+'"/>'+marks+lines+'</g></svg>'
}
