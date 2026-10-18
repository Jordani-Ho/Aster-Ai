import prompt from '../../../../prompts/student/abstract-tongue.md?raw'
import table from '../../../../domain/tcm/tongue-features.json'
import {parseTongueFeatures,tongueSvg,type TongueFeatures} from '../../../../domain/tcm/tongue'
import {VisionUnsupported,type VisionClient,type VisionMessage} from '../llm/vision'
// Ownership transfers to abstractTongue. Caller must not retain a Blob/File/data URL or a copy.
export interface TransientPhoto {bytes:Uint8Array|null;type:string}
export interface AbstractContext {shichen:string;jieqi:string;city:string}
export interface TongueAbstract extends AbstractContext {kind:'tongue';features:TongueFeatures;svg:string}
const RETAKE='这次没看清，请重新拍一张'
function imageData(bytes:Uint8Array,type:string):string {
 const valid=type==='image/png'?bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71:type==='image/jpeg'?bytes[0]===255&&bytes[1]===216:type==='image/webp'?String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP':false
 if(!valid||!bytes.length||bytes.length>10*1024*1024)throw Error(RETAKE)
 let binary=''
 for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
 return 'data:'+type+';base64,'+btoa(binary)
}
export async function abstractTongue(photo:TransientPhoto,context:AbstractContext,client:VisionClient):Promise<TongueAbstract> {
 const bytes=photo.bytes
 let messages:VisionMessage[]=[]
 try {
  if(!(bytes instanceof Uint8Array))throw Error(RETAKE)
  // Context stays local, never in model input. No identity, diagnosis, time or location is needed to read appearance.
  for(const value of [context.shichen,context.jieqi,context.city])if(typeof value!=='string'||!value.trim()||value.length>80||/[<>\r\n]|data:|https?:/i.test(value))throw Error(RETAKE)
  messages=[{role:'system',content:prompt+'\n'+JSON.stringify(table)},{role:'user',content:[{type:'image_url',image_url:{url:imageData(bytes,photo.type)}}]}]
  const reply=await client.describe(messages)
  const features=parseTongueFeatures(JSON.parse(reply))
  return {kind:'tongue',features,svg:tongueSvg(features),shichen:context.shichen,jieqi:context.jieqi,city:context.city}
 } catch(error) {
  if(error instanceof VisionUnsupported)throw error
  // Never propagate model response/request text (including accidental image echo) to UI/logs.
  throw Error(RETAKE)
 } finally {
  bytes?.fill(0);photo.bytes=null
  for(const message of messages)if(Array.isArray(message.content))for(const part of message.content)part.image_url.url=''
  messages.length=0
 }
}
