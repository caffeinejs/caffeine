import type { Logger } from '@caffeinejs/std/logger'
import { PinoLogger } from '@caffeinejs/std/logger/pino'

/**
 * The application logger.
 *
 * Built eagerly and handed to `createWebApplication` as `ApplicationOptions.logger`, which is the only path
 * that reaches the Fastify server: Fastify reads its logger while it constructs and exposes no setter
 * afterwards. A logger set through the `.logger(...)` feature callback would configure everything except the
 * server's own, which is why the level — and only the level — is what that callback adjusts once configuration
 * has resolved.
 *
 * Pino is where a transport, a destination, serializers and redaction are configured; `PinoLogger` takes either
 * the options to build one with or an instance built elsewhere.
 */
export function createLogger(): Logger {
  return new PinoLogger({
    // Overridden from PETSTORE_LOG__LEVEL once configuration resolves — see `.logger(...)` in app.ts.
    level: 'info',
    // A one-line summary per record rather than the default object dump, so the demo's output is readable in a
    // terminal without piping it anywhere.
    base: undefined,
  })
}
