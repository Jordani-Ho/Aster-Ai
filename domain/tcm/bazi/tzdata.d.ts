declare module 'tzdata' {
  const data: { version: string; zones: Record<string, unknown>; rules: Record<string, unknown> }
  export default data
}
