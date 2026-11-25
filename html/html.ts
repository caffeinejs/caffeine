import { Responder, type ActionResult, type IContext } from '@caffeinejs/http'

/**
 * What `@kitajs/html` evaluates a JSX expression to: the markup itself, or a promise of it when any
 * component in the tree is asynchronous. There is no render step to call.
 */
export type HTMLNode = string | Promise<string>

/**
 * Per-response override of the application's {@link HTMLDefaults.autoDoctype}. Content-Type cannot be
 * set here — see {@link HTML}.
 */
export interface HTMLOptions {
  doctype?: boolean
}

const DEFAULT_CONTENT_TYPE = 'text/html; charset=utf-8'
const DOCTYPE = '<!doctype html>'

/**
 * Answers with a JSX document.
 *
 * ```tsx
 * @Get('/')
 * index() {
 *   return HTML(<Home name="world" />)
 * }
 * ```
 *
 * Content-Type defaults to `text/html; charset=utf-8`, applied only when the response does not already
 * carry one — a route's `@Produces`, or a handler's own `ctx.header('content-type', ...)` call, both
 * survive undisturbed. There is no way to set Content-Type through this function; use `@Produces` or
 * `ctx.header(...)` instead. The `<!doctype html>` prefix comes from the route's `html` option, as the route set it
 * with `.config({ html: { … } })` or `.with(html(...))` resolved it, or `true` where none applies;
 * `options.doctype` overrides it for this response.
 *
 * `@kitajs/html` escapes nothing on its own: interpolated values need the `safe` attribute, and the
 * `@kitajs/ts-html-plugin` language-service plugin is what reports the ones that do not have it.
 */
export function HTML(node: HTMLNode, options?: HTMLOptions): HTMLResult {
  return new HTMLResult(node, options)
}

function isThenable(value: HTMLNode): value is Promise<string> {
  return typeof value !== 'string'
}

function applyDoctype(markup: string, autoDoctype: boolean): string {
  if (!autoDoctype) {
    return markup
  }

  const start = markup.trimStart()

  if (!/^<html[\s>]/i.test(start) || /^<!doctype/i.test(start)) {
    return markup
  }

  return DOCTYPE + markup
}

/** The route's `html` option, as the route set it or `html()` resolved it, or `true` where none applies. */
function autoDoctypeOf(ctx: IContext): boolean {
  return ctx.options.html?.autoDoctype ?? true
}

/**
 * Markup returned from a handler, an error handler or a middleware. The engine detects it and answers
 * with the rendered document under `text/html`.
 *
 * Not constructed directly — use {@link HTML}.
 */
class HTMLResult extends Responder {
  constructor(
    readonly node: HTMLNode,
    readonly options?: HTMLOptions,
  ) {
    super()
  }

  respond(ctx: IContext): ActionResult {
    const autoDoctype = this.options?.doctype ?? autoDoctypeOf(ctx)

    // Leave whatever Content-Type the reply already carries — from `@Produces`, which runs before the
    // handler, or the handler's own `ctx.header('content-type', ...)` call — and only fall back to the
    // default when neither set one.
    if (!ctx.hasHeader('content-type')) {
      ctx.header('content-type', DEFAULT_CONTENT_TYPE)
    }

    return isThenable(this.node)
      ? this.node.then(markup => applyDoctype(markup, autoDoctype))
      : applyDoctype(this.node, autoDoctype)
  }
}
