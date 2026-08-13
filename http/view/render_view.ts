import { ErrConfiguration } from '../error/common.js'
import type { ViewResult, ViewRenderOptions } from './view.js'

/**
 * Minimal shape we need off the reply — `@fastify/view` decorates `view` only when configured, so it is
 * optional here and guarded. Avoids threading Fastify's HTTP1/HTTP2 reply generics through this helper.
 */
export type ViewCapableReply = {
  view?: (page: string, data: object, opts?: ViewRenderOptions) => unknown
}

/**
 * Renders a {@link ViewResult} through `@fastify/view`'s `reply.view`, forwarding the per-render options
 * (e.g. a `layout` override). Shared by the route-handler path and the error-handler path. When the view
 * feature was never configured the decorator is absent — guarded here rather than crashing with a cryptic
 * "not a function".
 */
export function renderView(view: ViewResult, res: ViewCapableReply): unknown {
  if (typeof res.view !== 'function') {
    throw new ErrConfiguration(
      'Cannot render view: the view feature is not configured. Call app.view(v => v.engine(...))',
    )
  }

  return res.view(view.name, (view.model ?? {}) as object, view.options)
}
