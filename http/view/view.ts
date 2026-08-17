import type { FastifyViewOptions } from '@fastify/view'

/** Options the {@link ViewBuilder} assembles and binds; passed verbatim to `fastify.register(view, opts)`. */
export type ViewOptions = FastifyViewOptions

/**
 * Per-render options forwarded to `reply.<engine>(name, model, options)`. `layout` overrides the global
 * layout for this one render (mirrors `@fastify/view`'s `RouteSpecificOptions`). `engine` selects which
 * registered engine renders this view — the name passed to `app.view(name, ...)`; when unset, the default
 * engine (`reply.view`) is used.
 */
export interface ViewRenderOptions {
  layout?: string
  engine?: string
}

/**
 * Marker returned by {@link View} from a controller handler (or error handler). The Fastify adapter detects
 * it and renders through `reply.view(name, model, options)`. Not constructed directly — use {@link View}.
 */
export class ViewResult {
  constructor(
    readonly name: string,
    readonly model?: unknown,
    readonly options?: ViewRenderOptions,
  ) {}
}

/**
 * Declares a view response from a controller handler. `name` is the template (resolved by `@fastify/view`
 * against the configured `root`/`viewExt`); `model` is the optional data passed to the template; `options`
 * carries per-render settings such as a `layout` override.
 *
 * ```ts
 * @Get('/')
 * index() { return View('home', { title: 'Hi' }) }
 * ```
 */
export function View(name: string, model?: unknown, options?: ViewRenderOptions): ViewResult {
  return new ViewResult(name, model, options)
}
