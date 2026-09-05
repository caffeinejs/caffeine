import { type Service, type ServiceAPI, ServiceBeforeBootstrapIn } from '@caffeinejs/std'
import { defineFeatureConfig } from '@caffeinejs/std/config'

import { HTML_CONFIG_NAMESPACE, htmlConfigSchema, kHTMLConfig, type HTMLDefaults } from './config.js'

/**
 * Sets what every `HTML(...)` response starts from. Bound via `.extend(HTMLExt, h => …)`.
 *
 * There is one read path. `h.autoDoctype(false)` does not hold the value on the builder — it writes it into the
 * configuration tree in the `CODE` band, and a rendering response reads the merged result. So a setting made in
 * code is a **default**: an `HTML__AUTO_DOCTYPE` environment variable overrides it.
 *
 * Installing the feature is what registers the slice. An application that never calls it still renders —
 * {@link HTML_DEFAULTS} applies.
 */
export class HTMLBuilder implements Service {
  #autoDoctype: boolean | undefined

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

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    defineFeatureConfig<HTMLDefaults>(kit.config, {
      namespace: HTML_CONFIG_NAMESPACE,
      key: kHTMLConfig,
      schema: htmlConfigSchema,
      values: { autoDoctype: this.#autoDoctype },
    })
  }

  bootstrap(): Promise<void> {
    // Nothing to bind: the settings travel through the configuration tree, and `HTML(...)` reads them off the
    // context by key.
    return Promise.resolve()
  }
}
