import { createRequire } from 'node:module'
const requireApp = createRequire(new URL('../app/package.json', import.meta.url))
const { privateKeyFromSeedWords } = requireApp('nostr-tools/nip06')
const { getPublicKey } = requireApp('nostr-tools/pure')
// Public synthetic fixtures only. Never use these phrases for a real identity.
function actor(phrase) {
  const key = privateKeyFromSeedWords(phrase)
  return Object.freeze({ phrase, key: [...key], pubkey: getPublicKey(key) })
}
export const actors = Object.freeze({
  teacher: actor('leader monkey parrot ring guide accident before fence cannon height naive bean'),
  student: actor('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  outsider: actor('legal winner thank year wave sausage worth useful legal winner thank yellow'),
})
