import { buildBindingGraph, type HookListener, type InjectionToken, Binding } from '@caffeinejs/di'

import type { DevtoolsStore } from '../store.js'
import type { BindingSnapshot, DevtoolsEvent } from '../types.js'

function keyLabel(key: InjectionToken): string {
  if (typeof key === 'string') {
    return key
  }
  if (typeof key === 'symbol') {
    return key.toString()
  }
  return (key as { name?: string }).name ?? String(key)
}

function toSnapshot(key: InjectionToken, binding: Binding): BindingSnapshot {
  return {
    id: binding.id,
    key: keyLabel(key),
    scopeID: String(binding.scopeID),
    names: (binding.names ?? []).map(String),
    labels: (binding.labels ?? []).map(String),
    primary: binding.primary ?? false,
    lazy: binding.lazy ?? false,
    async: binding.async ?? false,
    internal: binding.internal ?? false,
  }
}

export class ContainerCollector {
  constructor(
    private readonly hooks: HookListener,
    private readonly store: DevtoolsStore,
    private readonly broadcast: (event: DevtoolsEvent) => void,
  ) {}

  backfill(entries: Iterable<[InjectionToken, Binding]>): void {
    const all = Array.from(entries)
    for (const [key, binding] of all) {
      this.store.addBinding(toSnapshot(key, binding))
    }
    this.store.setGraph(buildBindingGraph(all))
  }

  attach(entries: () => Iterable<[InjectionToken, Binding]>): void {
    this.hooks.on('onBindingRegistered', ({ key, binding }) => {
      this.store.addBinding(toSnapshot(key, binding))
      this.store.invalidateGraph(() => buildBindingGraph(entries()))

      const event: DevtoolsEvent = {
        kind: 'binding:registered',
        ts: Date.now(),
        payload: { id: binding.id, key: keyLabel(key), scopeID: String(binding.scopeID) },
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })

    this.hooks.on('onBindingInitialized', ({ key, binding }) => {
      const event: DevtoolsEvent = {
        kind: 'binding:initialized',
        ts: Date.now(),
        payload: { id: binding.id, key: keyLabel(key), async: binding.async ?? false },
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })

    this.hooks.on('onBindingInitializationFailed', ({ key, binding, error }) => {
      const event: DevtoolsEvent = {
        kind: 'binding:initialization-failed',
        ts: Date.now(),
        payload: {
          id: binding.id,
          key: keyLabel(key),
          error: error instanceof Error ? error.message : String(error),
        },
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })

    this.hooks.on('onModuleRegistered', ({ name, index }) => {
      const event: DevtoolsEvent = {
        kind: 'module:registered',
        ts: Date.now(),
        payload: { name, index },
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })

    this.hooks.on('onModuleRegistrationFailed', ({ name, index, error }) => {
      const event: DevtoolsEvent = {
        kind: 'module:failed',
        ts: Date.now(),
        payload: { name, index, error: error.message },
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })

    this.hooks.on('onDisposed', () => {
      const event: DevtoolsEvent = {
        kind: 'container:disposed',
        ts: Date.now(),
        payload: {},
      }
      this.store.pushEvent(event)
      this.broadcast(event)
    })
  }
}
