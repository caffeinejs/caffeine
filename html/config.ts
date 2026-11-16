import type { RouteDefinition } from '@caffeinejs/http'

/**
 * Response settings every `HTMLResult` starts from.
 */
export interface HTMLDefaults {
  /** Whether a document starting with `<html>` gains a `<!doctype html>` prefix. */
  autoDoctype: boolean
}

/**
 * What an application that never registered the HTML plugin renders with, so `HTML(...)` works on its own.
 */
export const HTML_DEFAULTS: HTMLDefaults = {
  autoDoctype: true,
}

/** What each route's `html()` was given, keyed by the route as `onRoute` saw it: the innermost plugin's wins. */
export const routeSettings = new WeakMap<RouteDefinition, Partial<HTMLDefaults>>()
