import { normalizePhrase } from './index'
export interface BackupChallenge { positions: number[]; words: string[] }
export function beginBackup(phrase: string): BackupChallenge {
  const words = normalizePhrase(phrase).split(' ')
  if (words.length !== 12) throw new Error('抄写核对需要 12 个词')
  const positions = new Set<number>()
  while (positions.size < 3) {
    const value = crypto.getRandomValues(new Uint8Array(1))[0]
    // Reject the remainder to avoid modulo bias.
    if (value < 252) positions.add(value % 12)
  }
  return { positions: [...positions].sort((a, b) => a - b), words }
}
export function checkBackup(challenge: BackupChallenge, answers: string[]): boolean {
  return answers.length === 3 && challenge.positions.length === 3 && challenge.positions.every((position, index) => answers[index].normalize('NFKD').trim() === challenge.words[position])
}
