import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist as simplified } from '@scure/bip39/wordlists/simplified-chinese.js'
import { wordlist as traditional } from '@scure/bip39/wordlists/traditional-chinese.js'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { privateKeyFromSeedWords } from 'nostr-tools/nip06'
import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'

export const languages = ['simplified', 'traditional', 'english'] as const
export type Language = typeof languages[number]
const wordlists = { simplified, traditional, english }
export const languageLabels: Record<Language, string> = { simplified: '简体中文', traditional: '繁體中文', english: 'English' }
export interface Identity {
  privateKey: Uint8Array
  publicKey: string
  npub: string
  language: Language
  account: number
}
export function normalizePhrase(phrase: string): string {
  const normalized = phrase.normalize('NFKD').toLowerCase().replace(/[\s，,、。.;；]+/gu, ' ').trim()
  const compact = normalized.replaceAll(' ', '')
  // Chinese BIP-39 words are single characters. Never translate simplified/traditional.
  if (/^\p{Script=Han}{12}$/u.test(compact)) return [...compact].join(' ')
  return normalized
}
export function generatePhrase(language: Language = 'simplified'): string {
  return generateMnemonic(wordlists[language], 128)
}
// Also accepts the official 24-word NIP-06 vector; the UI uses 12 words only.
export function createIdentity(input: string, language: Language, account = 0): Identity {
  if (!Number.isSafeInteger(account) || account < 0 || account >= 2 ** 31) throw new Error('账户序号必须是 0 至 2147483647 的整数')
  const phrase = normalizePhrase(input)
  if (!validateMnemonic(phrase, wordlists[language])) throw new Error('助记词校验失败，请检查文字及顺序')
  const privateKey = privateKeyFromSeedWords(phrase, '', account)
  const publicKey = getPublicKey(privateKey)
  return { privateKey, publicKey, npub: npubEncode(publicKey), language, account }
}
export function restoreIdentity(input: string, account = 0): Identity {
  const phrase = normalizePhrase(input)
  if (phrase.split(' ').length !== 12) throw new Error('请输入 12 个助记词；中文可连写，英文请用空格或标点分隔')
  const language = languages.find(candidate => validateMnemonic(phrase, wordlists[candidate]))
  if (!language) throw new Error('助记词校验失败，请检查文字及顺序；请用生成时的同一种文字恢复')
  return createIdentity(phrase, language, account)
}
