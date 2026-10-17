import { describe, expect, it } from 'vitest'
import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist as simplified } from '@scure/bip39/wordlists/simplified-chinese.js'
import { wordlist as traditional } from '@scure/bip39/wordlists/traditional-chinese.js'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { privateKeyFromSeedWords } from 'nostr-tools/nip06'
import { createIdentity, restoreIdentity, generatePhrase, languages } from './index'
import { beginBackup, checkBackup } from './backup'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const vectors = [
  ['leader monkey parrot ring guide accident before fence cannon height naive bean', '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a', '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917'],
  ['what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade', 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add', 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573'],
]
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('M1-01 identity acceptance', () => {
  it.each(vectors)('matches official NIP-06 vector %s', (phrase, secret, publicKey) => {
    const identity = createIdentity(phrase, 'english')
    expect(hex(identity.privateKey)).toBe(secret)
    expect(identity.publicKey).toBe(publicKey)
    expect(identity.npub).toMatch(/^npub1/)
  })
  it('restores deterministically and rejects a changed word', () => {
    expect(restoreIdentity(vectors[0][0]).publicKey).toBe(restoreIdentity(vectors[0][0]).publicKey)
    expect(() => restoreIdentity(vectors[0][0].replace('leader', 'invalidword'))).toThrow()
    expect(() => restoreIdentity(vectors[1][0])).toThrow()
  })
  // Synthetic fixture from library-generated zero entropy, not an official Chinese vector.
  const chinesePhrase = entropyToMnemonic(new Uint8Array(16), simplified)
  it.each([
    ['Chinese with spaces', chinesePhrase],
    ['Chinese with full-width spaces', chinesePhrase.replaceAll(' ', '\u3000')],
    ['Chinese without spaces', chinesePhrase.replaceAll(' ', '')],
    ['Chinese with Chinese commas', chinesePhrase.replaceAll(' ', '，')],
    ['capitalized English', vectors[0][0].replace(/\b[a-z]/g, letter => letter.toUpperCase())],
  ])('restores mobile input: %s', (_name, input) => {
    const canonical = /[a-z]/i.test(input) ? vectors[0][0] : chinesePhrase
    expect(restoreIdentity(input).publicKey).toBe(restoreIdentity(canonical).publicKey)
  })
  it('accepts uppercase English during backup verification', () => {
    const challenge = beginBackup(vectors[0][0])
    expect(checkBackup(challenge, challenge.positions.map(i => challenge.words[i].toUpperCase()))).toBe(true)
  })
  it.each([' ', '\u3000', '\n', '，', ',', '、', '。', '.', '；', ';'])('accepts separator %j', separator => {
    expect(restoreIdentity(` ${chinesePhrase.replaceAll(' ', separator)} `).publicKey).toBe(restoreIdentity(chinesePhrase).publicKey)
    expect(restoreIdentity(vectors[0][0].replaceAll(' ', separator)).publicKey).toBe(vectors[0][2])
  })
  it('restores traditional Chinese without spaces without converting characters', () => {
    const phrase = entropyToMnemonic(new Uint8Array(16).fill(255), traditional)
    expect(restoreIdentity(phrase.replaceAll(' ', '')).publicKey).toBe(createIdentity(phrase, 'traditional').publicKey)
  })
  it('rejects a fixed in-wordlist replacement with an invalid checksum', () => {
    const changed = vectors[0][0].replace('leader', 'abandon')
    expect(english).toContain('abandon')
    expect(validateMnemonic(changed, english)).toBe(false)
    expect(() => restoreIdentity(changed)).toThrow()
  })
  it.each(languages)('round trips %s and cross-checks both derivations', language => {
    const phrase = generatePhrase(language)
    expect(phrase.split(' ')).toHaveLength(12)
    const owner = createIdentity(phrase, language)
    expect(restoreIdentity(phrase).publicKey).toBe(owner.publicKey)
    for (const account of [0, 1, 2]) {
      const identity = createIdentity(phrase, language, account)
      const independent = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase, '')).derive(`m/44'/1237'/${account}'/0/0`).privateKey!
      expect(hex(identity.privateKey)).toBe(hex(independent))
      expect(hex(identity.privateKey)).toBe(hex(privateKeyFromSeedWords(phrase, '', account)))
      expect(createIdentity(phrase, language, account).publicKey).toBe(identity.publicKey)
    }
    expect(createIdentity(phrase, language, 1).publicKey).not.toBe(owner.publicKey)
  })
  it('uses the first valid wordlist and rejects invalid account numbers', () => {
    const phrase = generatePhrase('simplified')
    expect(restoreIdentity(phrase).language).toBe('simplified')
    for (const account of [-1, 1.5, 2 ** 31, NaN]) expect(() => createIdentity(phrase, 'simplified', account)).toThrow()
  })
  it('blocks completion for a wrong word and selects three distinct random positions', () => {
    const phrase = vectors[0][0]
    const challenge = beginBackup(phrase)
    expect(new Set(challenge.positions).size).toBe(3)
    expect(challenge.positions.every(i => i >= 0 && i < 12)).toBe(true)
    const answers = challenge.positions.map(i => phrase.split(' ')[i])
    expect(checkBackup(challenge, ['wrong', ...answers.slice(1)])).toBe(false)
    expect(checkBackup(challenge, answers)).toBe(true)
    expect(checkBackup(challenge, [])).toBe(false)
  })
  it('has no console output or browser persistence in identity and UI source', () => {
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)])
    for (const path of walk('src').filter(p => /\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts'))) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/console\s*\.|localStorage|sessionStorage/)
    }
  })
})
