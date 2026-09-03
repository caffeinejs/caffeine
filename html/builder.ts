import { ServiceBootstrapIn, type Service, type ServiceAPI } from '@caffeinejs/std'

import { HTMLExtension, HTML_DEFAULTS, type HTMLDefaults } from './extension.js'

/**
 * Sets what every `HTML(...)` response starts from. Bound via `.extend(HTMLExt, h => …)`.
 *
 * Installing the feature is the activating act: it binds {@link HTMLExtension}, which the adapter discovers
 * via `getManyOptional(ServerExtension)` and registers as a Fastify plugin. An application that never
 * calls it still renders — {@link HTML_DEFAULTS} applies.
 */
export class HTMLBuilder implements Service {
  #defaults: HTMLDefaults = { ...HTML_DEFAULTS }

  get name(): string {
    return 'html'
  }

  /**
   * Whether a document starting with `<html>` gains a `<!doctype html>` prefix. On by default; turn it
   * off for an application answering with fragments a client splices into a page.
   */
  autoDoctype(enabled: boolean): ServiceAPI<this> {
    this.#defaults = { ...this.#defaults, autoDoctype: enabled }
    return this
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    kit.container.bind(HTMLExtension, t => t.toValue(new HTMLExtension(this.#defaults)).extends())
    return Promise.resolve()
  }
}
