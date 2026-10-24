import { it, expect } from 'vitest'
import { takeSetupToken } from './setup-link'

// V2-31：扫码链接的口令在 #setup= 后；读到后去掉空白（复用 V2-28 的口令清理）。
it('从 #setup= 取出登记口令，去掉前后/中间空白；没有口令时返回空串', () => {
  expect(takeSetupToken('#setup=abcDEF-123_')).toBe('abcDEF-123_')
  expect(takeSetupToken('#setup=%20abc%20def%0A')).toBe('abcdef')
  expect(takeSetupToken('abc')).toBe('')
  expect(takeSetupToken('#setup=')).toBe('')
  expect(takeSetupToken('#setup=%E0%A4%A')).toBe('')
})
