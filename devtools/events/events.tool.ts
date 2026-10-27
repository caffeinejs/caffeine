import type { Container, InjectionToken } from '@caffeinejs/di'

import { maskCredentials } from '../config/redact.js'
import type { ToolInfo } from '../tool.js'
import type { ContainerEventKind, ContainerEventRecord } from './events.schema.js'

type Hooks = Container['hooks']

/** How many events the tool keeps; the oldest goes first. */
const CAPACITY = 500

export const eventsTool: ToolInfo = {
  id: 'events',
  title: 'Container events',
  description: 'What the container did since the devtools attached: bindings initialized, failures, modules',
}

/**
 * Records what the container did since it attached to its hooks: bindings registered, initialized or failing to,
 * modules registered, its disposal. The last 500 are kept.
 *
 * `DevTools()` attaches it before the container initializes, so the container's start-up is in it. `devTools()`
 * attaches it to a container already initialized, which emits little more than a re-resolved async binding and its
 * disposal.
 */
export class EventsTool {
  readonly #events: ContainerEventRecord[] = []
  #seq = 0

  constructor(hooks: Hooks) {
    const initialized = ({ key }: { key: InjectionToken }): void => this.#push('binding-initialized', keyText(key))
    const failed = ({ key, error }: { key: InjectionToken; error: unknown }): void =>
      this.#push('binding-initialization-failed', keyText(key), error)
    const registered = ({ key }: { key: InjectionToken }): void => this.#push('binding-registered', keyText(key))
    const module = ({ name }: { name: string }): void => this.#push('module-registered', name)
    const moduleFailed = ({ name, error }: { name: string; error: Error }): void =>
      this.#push('module-registration-failed', name, error)
    const disposed = (): void => {
      this.#push('container-disposed', undefined)
      hooks
        .off('onBindingInitialized', initialized)
        .off('onBindingInitializationFailed', failed)
        .off('onBindingRegistered', registered)
        .off('onModuleRegistered', module)
        .off('onModuleRegistrationFailed', moduleFailed)
        .off('onDisposed', disposed)
    }

    hooks
      .on('onBindingInitialized', initialized)
      .on('onBindingInitializationFailed', failed)
      .on('onBindingRegistered', registered)
      .on('onModuleRegistered', module)
      .on('onModuleRegistrationFailed', moduleFailed)
      .on('onDisposed', disposed)
  }

  #push(kind: ContainerEventKind, subject: string | undefined, error?: unknown): void {
    this.#events.push({
      seq: ++this.#seq,
      kind,
      subject,
      at: new Date().toISOString(),
      ...(error === undefined ? {} : { error: maskCredentials(messageOf(error)) }),
    })

    if (this.#events.length > CAPACITY) {
      this.#events.shift()
    }
  }

  list(after: number | undefined, last: number | undefined): ContainerEventRecord[] {
    const found = this.#events.filter(event => event.seq > (after ?? 0))

    if (last === undefined) {
      return found
    }

    // `slice(-0)` is `slice(0)`: every event.
    return last === 0 ? [] : found.slice(-last)
  }
}

/**
 * A failure's message: an `Error`'s own, or a thrown value as text. What a thrown object holds is not written out: it
 * may be a driver's configuration, its password included.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error !== null) {
    return Object.prototype.toString.call(error)
  }

  return String(error as string | number | boolean | bigint | symbol | undefined)
}

function keyText(key: InjectionToken): string {
  const unwrapped = typeof key === 'object' && key !== null && 'unwrap' in key ? key.unwrap() : key

  return typeof unwrapped === 'function' ? unwrapped.name : String(unwrapped)
}
