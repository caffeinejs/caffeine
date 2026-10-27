import { token } from '@caffeinejs/di'

import type { Logger } from './logger.js'

/**
 * The injection key of the application's {@link Logger}.
 *
 * ```ts
 * @Injectable([logToken()])
 * class CatalogService {
 *   constructor(private readonly log: Logger) {}
 * }
 * ```
 *
 * Always resolves once the container has initialized: `Application` binds the logger `.logger(...)` or
 * `ApplicationOptions.logger` configured, else a bare `ConsoleLogger`, during `bootstrap()`. Binding it yourself
 * fails with `ErrDuplicateBinding`.
 */
export function logToken() {
  return token<Logger>(Symbol.for('@caffeinejs/application:logger'))
}
