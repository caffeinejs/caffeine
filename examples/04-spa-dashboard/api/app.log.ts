import type { Logger } from '@caffeinejs/application/logger'
import { PinoLogger } from '@caffeinejs/application/logger/pino'

/**
 * The application logger.
 *
 * Built eagerly and handed to `createWebApplication` as `ApplicationOptions.logger`. `.logger(...)` in `app.ts`
 * adjusts its level once configuration has resolved, and nothing else.
 */
export function createLogger(): Logger {
  return new PinoLogger({
    // Overridden from SPA_LOG__LEVEL once configuration resolves.
    level: 'info',
    // One readable line per record instead of the default object dump.
    base: undefined,
  })
}
