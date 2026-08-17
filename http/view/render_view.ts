import { ErrConfiguration } from '../error/common.js'
import type { ViewResult, ViewRenderOptions } from './view.js'

type ViewRenderFn = (page: string, data: object, opts?: ViewRenderOptions) => unknown

/**
 * Minimal shape we need off the reply — `@fastify/view` decorates `view` for the default engine (and
 * `<name>` for each named one), only when configured, so it is optional here and guarded. Kept as the
 * default decorator so a Fastify reply matches structurally; named decorators are read by index.
 */
export type ViewCapableReply = {
  view?: ViewRenderFn
}

/**
 * Renders a {@link ViewResult} through the selected engine's `@fastify/view` reply decorator, forwarding
 * the per-render `layout` override. The engine is chosen by `view.options.engine` (the name passed to
 * `app.view(name, ...)`); when unset the default `reply.view` is used. Shared by the route-handler path
 * and the error-handler path. When the selected engine was never configured the decorator is absent —
 * guarded here rather than crashing with a cryptic "not a function".
 */
export function renderView(view: ViewResult, res: ViewCapableReply): unknown {
  const engine = view.options?.engine ?? 'view'
  const render = (res as Record<string, ViewRenderFn | undefined>)[engine]

  if (typeof render !== 'function') {
    throw new ErrConfiguration(
      `Cannot render view: engine "${engine}" is not configured. Call app.view(${engine === 'view' ? '' : `"${engine}", `}v => v.engine(...))`,
    )
  }

  // Invoke as a method so `this` stays bound to the reply — `@fastify/view`'s decorator calls
  // `this.send(...)` internally; a detached call would crash with "reading 'send' of undefined".
  return render.call(res, view.name, (view.model ?? {}) as object, { layout: view.options?.layout })
}
