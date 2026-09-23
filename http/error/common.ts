import { solutions } from './util.js'

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

/** The server was asked for before `ready()` built it. */
export class ErrApplicationNotReady extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot reach the server: the application is not ready' + solutions('Call "ready()" or "run()" first'),
      'ERR_APPLICATION_NOT_READY',
    )
    this.name = 'ErrApplicationNotReady'
  }
}
