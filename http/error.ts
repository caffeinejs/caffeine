export class ErrCaffeineWebApplication extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrCaffeineWebApplication'
    this.code = code
  }
}
