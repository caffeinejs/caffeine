import { inspect } from 'node:util'

import { $t, type InferSchema } from '@caffeinejs/application/schema'
import type { Container, InjectionToken } from '@caffeinejs/di'
import { Router } from '@caffeinejs/http'

import { maskCredentials } from '../config/redact.js'
import { ErrorSchema, type ToolInfo } from '../tool.js'

type Hooks = Container['hooks']

/** How many events the tool keeps; the oldest goes first. */
const CAPACITY = 500

export const ContainerEventSchema = $t.Object({
  /** Increases by one per event, from 1: what `?after=` reads from. */
  seq: $t.Integer(),
  kind: $t.UnionEnum([
    'binding-initialized',
    'binding-initialization-failed',
    'binding-registered',
    'module-registered',
    'module-registration-failed',
    'container-disposed',
  ]),
  /** The binding's key or the module's name. */
  subject: $t.Optional($t.String()),
  /** An ISO 8601 timestamp. */
  at: $t.String(),
  /** The failure's message, the password of any URL in it masked. */
  error: $t.Optional($t.String()),
})

export type ContainerEventRecord = InferSchema<typeof ContainerEventSchema>
export type ContainerEventKind = ContainerEventRecord['kind']

export const eventsTool: ToolInfo = {
  id: 'events',
  title: 'Container events',
  description: 'What the container did since the devtools attached: bindings initialized, failures, modules',
}

/**
 * What the container did since the tool attached to its hooks.
 *
 * - `GET /events`: the events, oldest first; `?after=<seq>` those after one, `?limit=<n>` the last `n`
 */
export function eventsRouter(tool: EventsTool) {
  return new Router('/events')
    .get('')
    .schema({
      querystring: $t.Object({
        after: $t.Optional($t.Integer({ minimum: 0 })),
        limit: $t.Optional($t.Integer({ minimum: 0 })),
      }),
      response: { 200: $t.Array(ContainerEventSchema), 400: ErrorSchema },
    })
    .handler(ctx => tool.list(ctx.req.query().after, ctx.req.query().limit))
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

/** A failure's message: an `Error`'s own, or what was thrown, written out. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : inspect(error)
}

function keyText(key: InjectionToken): string {
  const unwrapped = typeof key === 'object' && key !== null && 'unwrap' in key ? key.unwrap() : key

  return typeof unwrapped === 'function' ? unwrapped.name : String(unwrapped)
}
