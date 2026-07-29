export class CaffeineError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = `CAFFEINE_${code.toUpperCase()}`
  }
}
