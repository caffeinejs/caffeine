import type { Logger } from '@caffeinejs/std/logger'
import { PinoLogger } from '@caffeinejs/std/logger/pino'

/**
 * The application logger.
 *
 * Built eagerly and handed to `createWebApplication` as `ApplicationOptions.logger`, which is the only path
 * that reaches the Fastify server: Fastify reads its logger while it constructs and exposes no setter
 * afterwards. That is why `.logger(...)` in `app.ts` adjusts the level and nothing else.
 */
export function createLogger(): Logger {
  return new PinoLogger({
    // Overridden from SPA_LOG__LEVEL once configuration resolves.
    level: 'info',
    // One readable line per record instead of the default object dump.
    base: undefined,
  })
}
