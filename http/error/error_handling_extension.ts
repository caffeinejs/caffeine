import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'

import { ServerExtension, type ServerExtensionContext } from '../server_extension.js'
import { ErrCaffeineWebApplication } from './common.js'
import { ErrorHandlerProvider } from './error.js'
import { installGlobalErrorHandler, type GlobalErrorHandler } from './error_handling.js'

/**
 * Installs the application-wide error handler on the root server.
 *
 * `core`, so every route and hook an extension registers afterwards is already covered by it — including the
 * ones a package outside `http` contributes.
 */
export class ErrorHandlingExtension extends ServerExtension {
  readonly name = 'caffeine-error-handling'
  readonly [kExtensionStage]: ExtensionStage = 'core'

  #handler: GlobalErrorHandler | undefined

  /**
   * The application-wide handler. Each route group's own encapsulated handler falls back to it, which is why
   * the adapter reads it back rather than installing one per group.
   */
  get globalErrorHandler(): GlobalErrorHandler {
    if (this.#handler === undefined) {
      throw new ErrCaffeineWebApplication(
        'Cannot read the global error handler: the error handling extension has not configured yet',
        'ERR_ERROR_HANDLER_NOT_INSTALLED',
      )
    }

    return this.#handler
  }

  configure(ctx: ServerExtensionContext): void {
    this.#handler = installGlobalErrorHandler(ctx.server, ctx.container.get(ErrorHandlerProvider))
  }
}
