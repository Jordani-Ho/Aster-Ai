import {getPublicKey} from 'nostr-tools/pure'
import {npubEncode} from 'nostr-tools/nip19'
import type {Identity} from '../identity'
import {languages} from '../identity'
const encoder=new TextEncoder(),salt=encoder.encode('aster/passkey-prf/v1')
const bytes=(v:Uint8Array)=>new Uint8Array(v)
const hex=(v:ArrayBuffer)=>Array.from(new Uint8Array(v),b=>b.toString(16).padStart(2,'0')).join('')
const unhex=(v:string)=>Uint8Array.from(v.match(/../g)!.map(b=>parseInt(b,16)))
const b64=(v:Uint8Array)=>btoa(String.fromCharCode(...v))
const unb64=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0))
export class PrfUnavailable extends Error{constructor(){super('这台手机暂不支持')}}
export async function derivePrfKey(output:Uint8Array):Promise<CryptoKey>{
 if(output.length!==32)throw new PrfUnavailable()
 const input=await crypto.subtle.importKey('raw',bytes(output),'HKDF',false,['deriveKey'])
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:encoder.encode('aster/identity/aes-gcm/v1')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])
}
function result(credential:PublicKeyCredential|null){
 const value=(credential?.getClientExtensionResults() as {prf?:{results?:{first?:ArrayBuffer}}})?.prf?.results?.first
 if(!(value instanceof ArrayBuffer)||value.byteLength!==32)throw new PrfUnavailable()
 return new Uint8Array(value)
}
const extensions=()=>({prf:{eval:{first:salt}}}) as AuthenticationExtensionsClientInputs
export async function enrollPasskey(identity:Identity,api:CredentialsContainer=navigator.credentials,rpId=location.hostname){
 let created:Credential|null
 try{created=await api.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{id:rpId,name:'知衡'},user:{id:unhex(identity.publicKey),name:'知衡用户',displayName:'知衡用户'},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'},timeout:60000,extensions:extensions()}}) }catch(error){if(error instanceof DOMException && ['NotSupportedError','SecurityError'].includes(error.name))throw new PrfUnavailable();throw error}
 const credential=created as PublicKeyCredential|null
 if(!credential)throw new PrfUnavailable()
 // Always authenticate as well: some phones only produce PRF during get(), never during create().
 let assertion:PublicKeyCredential|null
 try{assertion=await api.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId,allowCredentials:[{type:'public-key',id:credential.rawId}],userVerification:'required',timeout:60000,extensions:extensions()}}) as PublicKeyCredential|null}catch(error){if(error instanceof DOMException && ['NotSupportedError','SecurityError'].includes(error.name))throw new PrfUnavailable();throw error}
 const output=result(assertion)
 try{return {key:await derivePrfKey(output)}}finally{output.fill(0)}
}
export async function authenticatePasskey(api:CredentialsContainer=navigator.credentials,rpId=location.hostname){
 const credential=await api.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId,userVerification:'required',timeout:60000,extensions:extensions()}}) as PublicKeyCredential|null
 const output=result(credential),handle=(credential!.response as AuthenticatorAssertionResponse).userHandle
 try{if(!handle||handle.byteLength!==32)throw Error('无法找到这份备份');return {key:await derivePrfKey(output),owner:hex(handle)}}finally{output.fill(0)}
}
export interface SealedIdentity{version:1;iv:string;ct:string}
export async function sealIdentity(identity:Identity,key:CryptoKey):Promise<SealedIdentity>{
 const iv=crypto.getRandomValues(new Uint8Array(12)),plain=encoder.encode(JSON.stringify({privateKey:[...identity.privateKey],language:identity.language,account:identity.account}))
 try{const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('aster.identity:'+identity.publicKey)},key,plain);return {version:1,iv:b64(iv),ct:b64(new Uint8Array(ct))}}finally{plain.fill(0)}
}
export async function openIdentity(input:SealedIdentity,owner:string,key:CryptoKey):Promise<Identity>{
 if(input.version!==1||!/^[0-9a-f]{64}$/.test(owner))throw Error('备份格式不匹配')
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(input.iv),additionalData:encoder.encode('aster.identity:'+owner)},key,unb64(input.ct)))
 try{const value=JSON.parse(new TextDecoder().decode(plain));if(!Array.isArray(value.privateKey)||value.privateKey.length!==32||value.privateKey.some((v:unknown)=>!Number.isInteger(v)||Number(v)<0||Number(v)>255)||!languages.includes(value.language)||!Number.isSafeInteger(value.account)||value.account<0||value.account>=2**31)throw Error('备份格式无效');const privateKey=Uint8Array.from(value.privateKey);if(getPublicKey(privateKey)!==owner){privateKey.fill(0);throw Error('备份身份不匹配')}return {privateKey,publicKey:owner,npub:npubEncode(owner),language:value.language,account:value.account}}finally{plain.fill(0)}
}
