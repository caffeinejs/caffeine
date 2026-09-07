import { $t } from '@caffeinejs/std'
import { featureConfigKey } from '@caffeinejs/std/config'

/**
 * Response settings every `HTMLResult` starts from.
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
 * Where a rendering `HTMLResult` finds the application's settings: `ctx.config(kHTMLConfig)`.
 *
 * A key rather than a path, because `HTML(...)` is called from application code that knows neither the
 * application's config type nor where in the tree the feature was placed — if it was placed anywhere at all.
 */
export const kHTMLConfig = featureConfigKey<HTMLDefaults>('html')

/**
 * The shape the HTML feature expects wherever the application decides to keep its settings. Import it into an
 * application schema and point the builder at it with `h.config(c => c.app.html)`.
 */
export const htmlConfigSchema = $t.Object({
  autoDoctype: $t.Boolean({ default: HTML_DEFAULTS.autoDoctype }),
})
