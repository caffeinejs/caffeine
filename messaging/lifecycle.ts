import type { ContainerOps, OnBootstrap, OnDestroy } from '@caffeinejs/di'

import type { MessagingContainer } from './engine.js'
import { Keys } from './symbols.js'

/**
 * Drives every configured messaging binder set off the container lifecycle: `onBootstrap` starts each
 * `MessagingContainer` during `container.init()`, `onDestroy` stops it during `container.dispose()`. One is
 * bound per application, covering every instance.
 */
export class MessagingLifecycle implements OnBootstrap, OnDestroy {
  readonly #container: ContainerOps

  constructor(container: ContainerOps) {
    this.#container = container
  }

  async onBootstrap(): Promise<void> {
    for (const { binding } of this.#container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
      await this.#container.wrapBinding<MessagingContainer>(binding).get().start()
    }
  }

  async onDestroy(): Promise<void> {
    for (const { binding } of this.#container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
      await this.#container.wrapBinding<MessagingContainer>(binding).get().stop()
    }
  }
}
