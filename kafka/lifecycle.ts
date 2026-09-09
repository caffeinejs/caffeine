import type { ContainerOps, OnBootstrap, OnDestroy } from '@caffeinejs/di'

import { ErrKafkaUnknownInstance } from './errors.js'
import type { KafkaListenerContainer } from './listener_container.js'
import { DEFAULT_INSTANCE, Keys } from './symbols.js'

/**
 * Drives every configured Kafka instance's engine off the container lifecycle: `onBootstrap` starts each
 * `KafkaListenerContainer` during `container.init()`, `onDestroy` stops it during `container.dispose()`. One
 * is bound per application, covering every instance.
 */
export class KafkaLifecycle implements OnBootstrap, OnDestroy {
  readonly #container: ContainerOps

  constructor(container: ContainerOps) {
    this.#container = container
  }

  async onBootstrap(): Promise<void> {
    const engines = this.#container
      .getBindingsByLabel(Keys.KAFKA_CONTAINER)
      .map(({ binding }) => this.#container.wrapBinding<KafkaListenerContainer>(binding).get())
    const configured = new Set(engines.map(engine => engine.name))

    // Fail fast: a handler tagged for an instance that was never configured would otherwise never run.
    for (const { key, binding } of this.#container.getBindingsByLabel(Keys.KAFKA_HANDLER)) {
      const instance = (binding.tags.get(Keys.KAFKA_INSTANCE) as string | undefined) ?? DEFAULT_INSTANCE
      if (!configured.has(instance)) {
        const handler = (binding.type as { name?: string } | undefined)?.name ?? String(key)
        throw new ErrKafkaUnknownInstance(handler, instance, [...configured])
      }
    }

    for (const engine of engines) {
      await engine.start()
    }
  }

  async onDestroy(): Promise<void> {
    for (const { binding } of this.#container.getBindingsByLabel(Keys.KAFKA_CONTAINER)) {
      await this.#container.wrapBinding<KafkaListenerContainer>(binding).get().stop()
    }
  }
}
