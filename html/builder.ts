import { type Service, type ServiceAPI, ServiceBeforeBootstrapIn } from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigHandle } from '@caffeinejs/std/config'

import { htmlConfigSchema, kHTMLConfig, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response starts from. Bound via `.extend(HTMLExt, h => …)`.
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
export class HTMLBuilder<C = unknown> implements Service {
  #autoDoctype: boolean | undefined
  #selector?: (c: ConfigHandle<C>) => HTMLDefaults

  get name(): string {
    return 'html'
  }

  /**
   * Whether a document starting with `<html>` gains a `<!doctype html>` prefix. On by default; turn it
   * off for an application answering with fragments a client splices into a page.
   */
  autoDoctype(enabled: boolean): ServiceAPI<this> {
    this.#autoDoctype = enabled
    return this
  }

  /**
   * Places the HTML settings in the configuration tree, e.g. `h.config(c => c.app.html)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   * Both the reads and the default written by {@link autoDoctype} go there, and the application's schema must
   * describe it — {@link htmlConfigSchema} is exported for that.
   */
  config(selector: (c: ConfigHandle<C>) => HTMLDefaults): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    defineFeatureConfig<HTMLDefaults>(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      key: kHTMLConfig,
      schema: htmlConfigSchema,
      values: { autoDoctype: this.#autoDoctype },
    })
  }

  bootstrap(): Promise<void> {
    // Nothing to bind: the settings travel through the configuration, and `HTML(...)` reads them off the
    // context by key.
    return Promise.resolve()
  }
}
