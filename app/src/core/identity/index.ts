import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'

// V2 身份：本机自动生成、直接存放（不再有助记词或恢复流程）。
export interface Identity {
  privateKey: Uint8Array
  publicKey: string
  npub: string
}
export function identityFromPrivateKey(privateKey: Uint8Array): Identity {
  if (privateKey.length !== 32) throw new Error('身份私钥长度错误')
  const publicKey = getPublicKey(privateKey)
  return { privateKey, publicKey, npub: npubEncode(publicKey) }
}
export function createIdentity(): Identity {
  return identityFromPrivateKey(generateSecretKey())
}
