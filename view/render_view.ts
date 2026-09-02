import { ErrConfiguration, ActionResult } from '@caffeinejs/http'
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
 * `ViewExt('mail')`); when unset the default `reply.view` is used. Shared by the route-handler path
 * and the error-handler path. When the selected engine was never configured the decorator is absent —
 * guarded here rather than crashing with a cryptic "not a function".
 */
export function renderView(view: ViewResult, res: ViewCapableReply): ActionResult {
  const engine = view.options?.engine ?? 'view'
  const render = (res as Record<string, ViewRenderFn | undefined>)[engine]

  if (typeof render !== 'function') {
    const named = engine === 'view'
      ? '.extend(ViewExt, v => v.engine(...))'
      : `.extend(ViewExt("${engine}"), v => v.engine(...))`
    throw new ErrConfiguration(
      `Cannot render view: engine "${engine}" is not configured. Call ${named}`,
    )
  }

  return render
    .call(res, view.name, (view.model ?? {}) as object, { layout: view.options?.layout }) as ActionResult
}
