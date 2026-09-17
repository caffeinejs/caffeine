import { FastifyContext, Responder, ActionResult, type Context, ErrConfiguration } from '@caffeinejs/http'
import { type FastifyViewOptions } from '@fastify/view'

/**
 * Describes the view engine options.
 */
export type ViewOptions = Exclude<FastifyViewOptions, 'propertyName' | 'asyncPropertyName'>

type ViewRenderFn = (page: string, data: object, opts?: ViewRenderOptions) => unknown

type ViewCapableReply = {
  view?: ViewRenderFn
}

/**
 * Per-render options forwarded to `reply.<engine>(name, model, options)`. `layout` overrides the global
 * layout for this one render (mirrors `@fastify/view`'s `RouteSpecificOptions`). `engine` selects which
 * registered engine renders this view — the name passed to `v.add('mail', …)`; when unset, the default
 * engine (`reply.view`) is used.
 */
export interface ViewRenderOptions {
  layout?: string
  engine?: string
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

/**
 * Renders a {@link ViewResult} through the selected engine's `@fastify/view` reply decorator, forwarding
 * the per-render `layout` override. The engine is chosen by `view.options.engine` (the name passed to
 * `v.add('mail', …)`); when unset the default `reply.view` is used. Shared by the route-handler path
 * and the error-handler path. When the selected engine was never configured the decorator is absent —
 * guarded here rather than crashing with a cryptic "not a function".
 */
function renderView(view: ViewResult, res: ViewCapableReply): ActionResult {
  const engine = view.options?.engine ?? 'view'
  const render = (res as Record<string, ViewRenderFn | undefined>)[engine]

  if (typeof render !== 'function') {
    const named =
      engine === 'view'
        ? '.with(view(v => v.add(e => e.engine(...))))'
        : `.with(view(v => v.add("${engine}", e => e.engine(...))))`
    throw new ErrConfiguration(`Cannot render view: engine "${engine}" is not configured. Call ${named}`)
  }

  return render.call(res, view.name, (view.model ?? {}) as object, { layout: view.options?.layout }) as ActionResult
}

/**
 * Marker returned by {@link View} from a controller handler (or error handler). The Fastify adapter detects
 * it and renders through `reply.view(name, model, options)`. Not constructed directly — use {@link View}.
 */
class ViewResult extends Responder {
  constructor(
    readonly name: string,
    readonly model?: unknown,
    readonly options?: ViewRenderOptions,
  ) {
    super()
  }

  respond(ctx: Context): ActionResult {
    return renderView(this, (ctx as FastifyContext).fst.reply as ViewCapableReply)
  }
}
