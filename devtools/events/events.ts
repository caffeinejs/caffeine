import { DevTool, ErrDevToolInvalid, type DevToolOperation } from '@caffeinejs/application/devtools'
import type { Container, InjectionToken } from '@caffeinejs/di'

type Hooks = Container['hooks']

/** How many events the tool keeps; the oldest goes first. */
const CAPACITY = 500

export type ContainerEventKind =
  | 'binding-initialized'
  | 'binding-initialization-failed'
  | 'binding-registered'
  | 'module-registered'
  | 'module-registration-failed'
  | 'container-disposed'

export interface ContainerEventRecord {
  /** Increases by one per event, from 1: what `?after=` reads from. */
  readonly seq: number
  readonly kind: ContainerEventKind
  /** The binding's key or the module's name. */
  readonly subject: string | undefined
  /** An ISO 8601 timestamp. */
  readonly at: string
  readonly error?: string
}

/**
 * What the container did since the tool attached to its hooks: bindings registered, initialized or failing to,
 * modules registered, its disposal. The last 500 are kept.
 *
 * `DevTools()` attaches it before the container initializes, so the container's start-up is in it. `devTools()`
 * attaches it to a container already initialized, which emits little more than a re-resolved async binding and its
 * disposal.
 *
 * - `GET /events`: the events, oldest first; `?after=<seq>` those after one, `?limit=<n>` the last `n`
 */
export class EventsTool extends DevTool {
  readonly id = 'events'
  readonly title = 'Container events'
  readonly description = 'What the container did since the devtools attached: bindings initialized, failures, modules'
  readonly operations: readonly DevToolOperation[]

  readonly #events: ContainerEventRecord[] = []
  #seq = 0

  constructor(hooks: Hooks) {
    super()
    this.operations = [{ method: 'GET', path: '', handle: ({ query }) => this.#list(query.after, query.limit) }]

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
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    })

    if (this.#events.length > CAPACITY) {
      this.#events.shift()
    }
  }

  #list(after: string | undefined, limit: string | undefined): ContainerEventRecord[] {
    const since = count('after', after) ?? 0
    const last = count('limit', limit)
    const found = this.#events.filter(event => event.seq > since)

    return last === undefined ? found : found.slice(-last)
  }
}

function count(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!/^\d+$/.test(value)) {
    throw new ErrDevToolInvalid(`Cannot list events: "${name}" must be a whole number`)
  }

  return Number(value)
}

function keyText(key: InjectionToken): string {
  const unwrapped = typeof key === 'object' && key !== null && 'unwrap' in key ? key.unwrap() : key

  return typeof unwrapped === 'function' ? unwrapped.name : String(unwrapped)
}
