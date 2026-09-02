import { ServerExtension, type ServerExtensionContext } from '@caffeinejs/http'

/**
 * Response settings every {@link HTMLResult} starts from.
 */
export interface HTMLDefaults {
  /** Whether a document starting with `<html>` gains a `<!doctype html>` prefix. */
  autoDoctype: boolean
}

/**
 * What an application that never installed `HTMLExt` renders with, so `HTML(...)` works on its own.
 */
export const HTML_DEFAULTS: HTMLDefaults = {
  autoDoctype: true,
}

/**
 * The Fastify decoration {@link HTMLExtension} writes and {@link HTMLResult} reads.
 *
 * A symbol rather than a name, so the decoration cannot collide with an application's own and the
 * `fastify` module needs no augmentation.
 */
export const kHTMLDefaults = Symbol.for('caffeine.html.defaults')

/**
 * Publishes the application's {@link HTMLDefaults} on the Fastify instance, where an {@link HTMLResult}
 * rendering a request finds them.
 */
export class HTMLExtension extends ServerExtension {
  readonly name = 'html'

  readonly #defaults: HTMLDefaults

  constructor(defaults: HTMLDefaults = HTML_DEFAULTS) {
    super()
    this.#defaults = defaults
  }

  configure = (ctx: ServerExtensionContext): void => {
    ctx.server.decorate(kHTMLDefaults, this.#defaults)
  }
}
