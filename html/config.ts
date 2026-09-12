import { $t } from '@caffeinejs/std'

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

/**
 * Where the plugin leaves the settings: a decoration on the Fastify instance it registered into.
 *
 * A decoration rather than a container binding, because `HTML(...)` is called from application code holding
 * only a context — and because the instance a request was served by is the one whose settings apply, so a
 * plugin registered inside a route group parameterizes that group alone.
 */
export const kHTMLOptions = Symbol.for('@caffeinejs/html:options')

/**
 * The shape the HTML plugin expects wherever the application decides to keep its settings. Import it into an
 * application schema rather than restating it, then read that node: `.plugin(c => htmlPlugin(c.app.html))`.
 */
export const htmlConfigSchema = $t.Object({
  autoDoctype: $t.Boolean({ default: HTML_DEFAULTS.autoDoctype }),
})
