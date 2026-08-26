import { ErrCaffeineWebApplication } from '../error/common.js'

/**
 * ErrPipelineSealed is thrown when a middleware is registered after the application is ready.
 *
 * The pipeline is composed into the routes at start-up, so a later registration would silently never run.
 * Refusing it is the only way the caller finds out.
 */
export class ErrPipelineSealed extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot register a middleware: the application is already started, and the pipeline was composed at '
      + 'start-up',
      'ERR_PIPELINE_SEALED',
    )
    this.name = 'ErrPipelineSealed'
  }
}

/**
 * ErrNextCalledTwice is thrown when one middleware calls `next()` more than once.
 *
 * The second call would run the rest of the pipeline — and the handler — a second time, against a request
 * that is often already answered. Treated as the programming error it is rather than deduplicated, because
 * a middleware that does this has lost track of its own control flow.
 */
export class ErrNextCalledTwice extends ErrCaffeineWebApplication {
  constructor() {
    super('Cannot continue the pipeline: next() was called more than once by the same middleware', 'ERR_NEXT_CALLED_TWICE')
    this.name = 'ErrNextCalledTwice'
  }
}

/**
 * ErrAuthenticationMiddlewareMissing is thrown at start-up when routes are protected but nothing
 * authenticates them.
 *
 * The pipeline is explicit by design, which introduces exactly one way to disable every guard in the
 * application: forget the registration. So it is a start-up failure — the alternative is an application
 * that serves protected routes to anonymous callers and reports nothing.
 */
export class ErrAuthenticationMiddlewareMissing extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot start application: routes are protected but the authentication middleware is not registered: '
      + 'call app.useAuthenticationAndAuthorization()',
      'ERR_AUTHENTICATION_MIDDLEWARE_MISSING',
    )
    this.name = 'ErrAuthenticationMiddlewareMissing'
  }
}

/**
 * ErrAuthenticationNotConfigured is thrown when the authentication middleware is registered on an
 * application that never configured authentication.
 *
 * The middleware has no scheme to run and would leave every principal anonymous, so a protected route would
 * reject every caller. Caught at start-up, next to the registration that caused it.
 */
export class ErrAuthenticationNotConfigured extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot register the authentication middleware: authentication is not configured: call '
      + '.authentication(auth => ...) on the application builder',
      'ERR_AUTHENTICATION_NOT_CONFIGURED',
    )
    this.name = 'ErrAuthenticationNotConfigured'
  }
}
