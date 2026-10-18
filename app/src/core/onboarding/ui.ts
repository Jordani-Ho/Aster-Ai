export function uiError(cause:unknown,fallback='操作未完成，请稍后重试。'):string{
 const text=cause instanceof Error?cause.message:fallback
 return /密钥|私钥|公钥|npub|十六进制/i.test(text)?fallback:text
}
