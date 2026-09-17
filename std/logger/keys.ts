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
 * Always resolves: `Application` binds a bare `ConsoleLogger` the moment it constructs, whether or not
 * `.logger(...)` was called.
 */
export function logToken() {
  return token<Logger>(Symbol.for('@caffeinejs/std:logger'))
}
