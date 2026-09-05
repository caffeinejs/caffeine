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

/** The default location of the HTML settings in the configuration tree. */
export const HTML_CONFIG_NAMESPACE: readonly string[] = ['html']

/**
 * Where a rendering `HTMLResult` finds the application's settings: `ctx.config(kHTMLConfig)`.
 *
 * A key rather than the namespace, because `HTML(...)` is called from application code that knows neither the
 * application's config type nor where in the tree the feature ended up.
 */
export const kHTMLConfig = featureConfigKey<HTMLDefaults>('html')

export const htmlConfigSchema = $t.Object({
  autoDoctype: $t.Boolean({ default: HTML_DEFAULTS.autoDoctype }),
})
