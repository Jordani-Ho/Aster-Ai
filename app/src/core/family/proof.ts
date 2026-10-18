import { finalizeEvent, getEventHash, verifyEvent, type Event } from 'nostr-tools/pure'
import type { Identity } from '../identity'

// M1-22 代管证明：老师端不能只凭问诊包里的 manager 字段就把扣费记到别人账上。
// 代管人（根身份）用自己私钥签一个 kind 2732 小事件，content 固定，tags 指向家人公钥；
// 老师端重算 id、验签、核对签名人/p 标签/发件人，全部通过才认这个代管人。
export const FAMILY_PROOF_KIND = 2732
export const FAMILY_PROOF_CONTENT = 'aster.family.v1'
const HEX64 = /^[0-9a-f]{64}$/

export interface FamilyProof {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export function createFamilyProof(manager: Identity, member: string, now = Math.floor(Date.now() / 1000)): FamilyProof {
  if (!HEX64.test(member)) throw new Error('家人公钥格式无效')
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('证明时间无效')
  const event = finalizeEvent({ kind: FAMILY_PROOF_KIND, created_at: now, tags: [['p', member]], content: FAMILY_PROOF_CONTENT }, manager.privateKey)
  return JSON.parse(JSON.stringify(event)) as FamilyProof
}

function parseProof(input: unknown): FamilyProof {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代管证明格式无效')
  const value = input as Record<string, unknown>
  if (typeof value.id !== 'string' || !HEX64.test(value.id)) throw new Error('代管证明格式无效')
  if (typeof value.pubkey !== 'string' || !HEX64.test(value.pubkey)) throw new Error('代管证明格式无效')
  if (!Number.isSafeInteger(value.created_at) || (value.created_at as number) <= 0) throw new Error('代管证明格式无效')
  if (value.kind !== FAMILY_PROOF_KIND) throw new Error('代管证明类型不对')
  if (value.content !== FAMILY_PROOF_CONTENT) throw new Error('代管证明内容不对')
  if (typeof value.sig !== 'string' || value.sig === '') throw new Error('代管证明格式无效')
  if (!Array.isArray(value.tags) || !value.tags.every(tag => Array.isArray(tag) && tag.every(item => typeof item === 'string'))) throw new Error('代管证明格式无效')
  return {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at as number,
    kind: FAMILY_PROOF_KIND,
    tags: (value.tags as string[][]).map(tag => [...tag]),
    content: FAMILY_PROOF_CONTENT,
    sig: value.sig,
  }
}

// 老师端校验：证明由 manager 签发、p 标签指向家人、家人就是问诊包发件人。任一项不对就抛错。
export function verifyFamilyProof(input: unknown, expected: { manager: string; member: string; sender: string }): FamilyProof {
  if (!HEX64.test(expected.manager) || !HEX64.test(expected.member) || !HEX64.test(expected.sender)) throw new Error('代管证明主体无效')
  if (expected.manager === expected.member) throw new Error('代管人不能是家人本人')
  if (expected.member !== expected.sender) throw new Error('家人与发件人不一致')
  const proof = parseProof(input)
  // 先重算事件 id，确认 content/tags 与 id 绑定，再验签（E-004）。
  const event: Event = { id: proof.id, pubkey: proof.pubkey, kind: proof.kind, created_at: proof.created_at, tags: proof.tags.map(tag => [...tag]), content: proof.content, sig: proof.sig }
  if (getEventHash(event) !== proof.id) throw new Error('代管证明内容与事件 id 不一致')
  if (!verifyEvent(event)) throw new Error('代管证明签名校验失败')
  if (proof.pubkey !== expected.manager) throw new Error('代管证明不是代管人签的')
  const p = proof.tags.filter(tag => tag[0] === 'p')
  if (p.length !== 1 || p[0].length !== 2 || p[0][1] !== expected.member) throw new Error('代管证明指向的家人不一致')
  return proof
}
