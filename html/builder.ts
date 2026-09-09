import { FeatureBuilder, kFeatureName } from '@caffeinejs/std'

import { htmlConfigSchema, kHTMLConfig, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response starts from. Bound via `.extend(HTMLExt(), h => …)`.
 *
 * `h.autoDoctype(false)` does not hold the value on the builder — it goes through the configuration, and a
 * rendering response reads what resolved. {@link config} is what places those settings in the configuration
 * tree: with `h.config(c => c.app.html)` an `APP__HTML__AUTO_DOCTYPE` environment variable overrides the
 * builder, which makes a setting made in code a **default**. Without it the settings resolve from the builder
 * and {@link HTML_DEFAULTS} alone.
 *
 * Installing the feature is what registers the slice. An application that never calls it still renders —
 * {@link HTML_DEFAULTS} applies.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class HTMLBuilder<C = unknown> extends FeatureBuilder<HTMLDefaults, C> {
  readonly [kFeatureName] = 'html'

  protected readonly schema = htmlConfigSchema
  protected readonly configKey = kHTMLConfig

  /**
   * Whether a document starting with `<html>` gains a `<!doctype html>` prefix. On by default; turn it
   * off for an application answering with fragments a client splices into a page.
   */
  autoDoctype(enabled: boolean): this {
    return this.set('autoDoctype', enabled)
  }

  protected bootstrap(): void {
    // Nothing to bind: the settings travel through the configuration, and `HTML(...)` reads them off the
    // context by key.
  }
}
