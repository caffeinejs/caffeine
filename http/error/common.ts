export class ErrCaffeineWebApplication extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrCaffeineWebApplication'
    this.code = code
  }
}

export class ErrConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_CONFIGURATION')
    this.name = 'ErrConfiguration'
  }
}
