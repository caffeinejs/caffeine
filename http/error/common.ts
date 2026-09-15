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
    super(message, 'CFN_ERR_CONFIGURATION')
  }
}

/** The graceful shutdown exceeded its budget and connections were closed by force. */
export class ErrShutdownTimeout extends ErrCaffeineWebApplication {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(
      `Cannot complete graceful shutdown: in-flight requests did not finish within ${timeoutMs}ms`,
      'ERR_SHUTDOWN_TIMEOUT',
    )
    this.name = 'ErrShutdownTimeout'
    this.timeoutMs = timeoutMs
  }
}
