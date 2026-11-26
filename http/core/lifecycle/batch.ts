import { HTTPPlugin, type HTTPSetupContext } from '../../plugin.js'
import { type HookFn, type HookName, type RequestHookName, type RequestHooks, type ServerHooks } from './lifecycle.js'

/**
 * The hooks one entry of a plugin slot added: a `.with(...)` factory and the `HTTPPlugin` it returned, or one
 * `app.hook(...)` call. Kept where that entry stands among the slot's plugins, which is the order its hooks run in.
 */
export class HookBatch {
  /** The context the entry registered with: what its server hooks are handed. */
  readonly kit: HTTPSetupContext

  readonly request: { [K in RequestHookName]: RequestHooks[K][] } = {
    onRequest: [],
    preHandler: [],
    onSend: [],
    onResponse: [],
    onError: [],
  }

  readonly onRoute: ServerHooks['onRoute'][] = []
  readonly onReady: ServerHooks['onReady'][] = []
  readonly onClose: ServerHooks['onClose'][] = []

  constructor(kit: HTTPSetupContext) {
    this.kit = kit
  }

  /** Adds `fn` at `name`, a point the caller has checked. */
  add<K extends HookName>(name: K, fn: HookFn<K>): void {
    const list = name in this.request ? this.request[name as RequestHookName] : this[name as keyof ServerHooks]
    ;(list as unknown[]).push(fn)
  }
}

/** What `app.hook(...)` and `listener.hook(...)` add to `.with(...)`'s list, so the hook keeps its written position. */
export class HookRegistration extends HTTPPlugin {
  readonly #name: HookName
  readonly #fn: HookFn<HookName>

  constructor(name: HookName, fn: HookFn<HookName>) {
    super()
    this.#name = name
    this.#fn = fn
  }

  register(context: HTTPSetupContext): void {
    context.server.hook(this.#name, this.#fn as never)
  }
}
