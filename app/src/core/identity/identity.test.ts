import { describe, expect, it } from 'vitest'
import { createIdentity, identityFromPrivateKey } from './index'

const HEX64 = /^[0-9a-f]{64}$/

describe('V2 identity: generated locally and stored directly', () => {
  it('generates a fresh 32-byte secret key, public key and npub', () => {
    const identity = createIdentity()
    expect(identity.privateKey).toBeInstanceOf(Uint8Array)
    expect(identity.privateKey).toHaveLength(32)
    expect(identity.publicKey).toMatch(HEX64)
    expect(identity.npub).toMatch(/^npub1/)
    expect(identity.npub).not.toContain(identity.publicKey)
  })

  it('generates a different identity every time', () => {
    const first = createIdentity()
    const second = createIdentity()
    expect(Buffer.from(first.privateKey).equals(Buffer.from(second.privateKey))).toBe(false)
    expect(first.publicKey).not.toBe(second.publicKey)
  })

  it('rebuilds the same identity from its private key', () => {
    const original = createIdentity()
    const restored = identityFromPrivateKey(Uint8Array.from(original.privateKey))
    expect(Buffer.from(restored.privateKey).equals(Buffer.from(original.privateKey))).toBe(true)
    expect(restored.publicKey).toBe(original.publicKey)
    expect(restored.npub).toBe(original.npub)
  })

  it('rejects private keys that are not 32 bytes', () => {
    expect(() => identityFromPrivateKey(new Uint8Array(0))).toThrow('身份私钥长度错误')
    expect(() => identityFromPrivateKey(new Uint8Array(31))).toThrow('身份私钥长度错误')
    expect(() => identityFromPrivateKey(new Uint8Array(33))).toThrow('身份私钥长度错误')
  })

  it('has no mnemonic, language or account fields', () => {
    const identity = createIdentity()
    expect(identity).not.toHaveProperty('language')
    expect(identity).not.toHaveProperty('account')
    expect(identity).not.toHaveProperty('words')
  })
})
