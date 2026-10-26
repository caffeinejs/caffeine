import { ErrCaffeineWebApplication } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'

/**
 * Devtools refused to start where `NODE_ENV` is `production` and `allowProduction()` was not called.
 *
 * The devtools describe the application to whoever can reach them: its bindings, its configuration, its routes and
 * what protects each one. Production asks for that on purpose, never by default.
 */
export class ErrDevToolsInProduction extends ErrCaffeineWebApplication {
  constructor(...solutions: string[]) {
    super(
      errMessage('Cannot install devtools: NODE_ENV is "production"')
        .solutions(
          ...solutions,
          'Call "allowProduction()" on the devtools builder, and protect the endpoints with "authorize(...)"',
          'Leave devtools out of production builds',
        )
        .reference('@caffeinejs/devtools', ErrDevToolsInProduction)
        .build(),
      'ERR_DEVTOOLS_IN_PRODUCTION',
    )
    this.name = 'ErrDevToolsInProduction'
  }
}

/** A devtools option or a tool is malformed: a path, a port, an id, an operation. Thrown at start-up. */
export class ErrDevToolsConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_DEVTOOLS_CONFIGURATION')
    this.name = 'ErrDevToolsConfiguration'
  }
}
