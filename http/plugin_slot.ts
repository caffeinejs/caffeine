import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from './core/error/common.js'
import { HookBatch } from './core/lifecycle/batch.js'
import { assertHookName, HOOK_NAMES, type HookFn, type HookName } from './core/lifecycle/lifecycle.js'
import type { RouteMatcherFactory } from './core/matcher/matcher.js'
import { parseUse } from './core/middleware/middleware.js'
import { MiddlewarePipeline } from './core/middleware/pipeline.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import { configurationError } from './core/server/error.js'
import { HTTPPlugin, type HTTPSetupContext, type ScopedServer } from './plugin.js'
import type { ServerAddress } from './server.js'

type Operation = 'mount' | 'use' | 'useFn' | 'hook' | 'hasPlugin'

/** The server a slot belongs to, as its owner knows it once the server's settings have resolved. */
export interface SlotIdentity {
  readonly name: string | undefined
  readonly basePath: string
  readonly matcher: RouteMatcherFactory
  /** Reads where the server listens, each time it is asked. */
  readonly address: () => ServerAddress | undefined
}

/**
 * `context.server` for one plugin slot: the server's `.with(...)`, one place a router is mounted at, or one controller.
 * What is mounted is recorded in {@link mounted} for whoever owns the slot to serve, and middleware goes into the
 * pipeline it was given. Every operation is refused unless {@link during} is running, so a context kept past its slot
 * is refused whether the slot finished or failed; the identity stays readable.
 */
export class PluginSlot implements ScopedServer<any> {
  /** What was mounted while the slot was open, in call order. */
  readonly mounted: AnyRouter[] = []

  readonly #middlewares: MiddlewarePipeline
  readonly #prefix: string
  /** The slot this one is nested in: the enclosing router's or controller's, or the server's. */
  readonly #parent: PluginSlot | undefined
  /** The names of the plugins claimed in this slot so far. */
  readonly #names = new Set<string>()
  #open = false
  /** Where `hook(...)` adds: the batch of the slot entry running now. */
  #batch: HookBatch | undefined
  #identity: SlotIdentity | undefined

  /**
   * @param prefix - Where the slot's routes start: `''` for a server's, a router's or controller's full path.
   * @param parent - The slot this one is nested in, whose plugins {@link hasPlugin} sees too.
   */
  constructor(middlewares: MiddlewarePipeline = new MiddlewarePipeline(), prefix = '', parent?: PluginSlot) {
    this.#middlewares = middlewares
    this.#prefix = prefix
    this.#parent = parent
  }

  get name(): string | undefined {
    return this.#server().name
  }

  get basePath(): string {
    return this.#server().basePath
  }

  get prefix(): string {
    return this.#prefix
  }

  get matcher(): RouteMatcherFactory {
    return this.#server().matcher
  }

  get address(): ServerAddress | undefined {
    return this.#server().address()
  }

  /** Whether the slot is a router's or a controller's, nested in its server's. */
  get nested(): boolean {
    return this.#parent !== undefined
  }

  /** The server this slot belongs to. Called once, before the slot opens. */
  forServer(identity: SlotIdentity): void {
    this.#identity = identity
  }

  #server(): SlotIdentity {
    if (this.#identity === undefined) {
      throw new ErrConfiguration(
        errMessage('Cannot read the server of a plugin slot: the slot belongs to no server yet')
          .solutions('Read it from a ".with(...)" factory or from "HTTPPlugin.register"')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    return this.#identity
  }

  /** Runs `work` with the slot open, and closes it on every way out. */
  async during<R>(work: () => Promise<R>): Promise<R> {
    this.#open = true

    try {
      return await work()
    } finally {
      this.#open = false
    }
  }

  /**
   * Runs one entry of the slot: the factory, then the plugin it produced, its name claimed and its `register` run.
   * `keep` is handed the batch the entry's hooks go into before the factory runs, so the hooks of an entry that fails
   * partway are kept too: an `onClose` it added before failing still runs.
   *
   * @throws ErrConfiguration when the factory produced no `HTTPPlugin`, or a plugin with an empty name.
   */
  async run(
    factory: (context: HTTPSetupContext) => unknown,
    context: HTTPSetupContext,
    where: string,
    keep: (batch: HookBatch) => void,
  ): Promise<void> {
    // This entry's own server: open while its factory and `register` run, refused once they return, whatever the slot.
    const server = new EntryServer(this)
    const entry: HTTPSetupContext = { ...context, server }
    const batch = new HookBatch(entry)
    this.#batch = batch
    keep(batch)

    try {
      const plugin = await factory(entry)

      if (!(plugin instanceof HTTPPlugin)) {
        throw configurationError(
          `Cannot install a server plugin ${where}: only an HTTPPlugin can be installed`,
          'Return an HTTPPlugin instance from the factory given to ".with(...)" or "@Use(...)"',
        )
      }

      this.claim(plugin, where)
      await plugin.register(entry)
    } finally {
      this.#batch = undefined
      server.close()
    }
  }

  /**
   * Records `plugin`'s name in this slot.
   *
   * @throws ErrConfiguration for an empty name.
   */
  claim(plugin: HTTPPlugin, where: string): void {
    const name = plugin.name

    if (name === undefined) {
      return
    }

    if (name === '') {
      throw new ErrConfiguration(
        errMessage(`Cannot register a plugin with an empty name ${where}`)
          .solutions('Give it a name, or leave the name out')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.#names.add(name)
  }

  hook<K extends HookName>(name: K, fn: HookFn<K, any>): this {
    // Set only while an entry of an open slot runs.
    if (this.#batch === undefined) {
      throw slotClosed('hook')
    }

    assertHookName(name, HOOK_NAMES, 'with context.server.hook')
    this.#batch.add(name, fn as HookFn<K>)
    return this
  }

  hasPlugin(name: string): boolean {
    assertOpen(this.#open, 'hasPlugin')
    return this.#has(name)
  }

  #has(name: string): boolean {
    const parent = this.#parent
    return this.#names.has(name) || (parent !== undefined && parent.#has(name))
  }

  mount(...routers: AnyRouter[]): this {
    assertOpen(this.#open, 'mount')
    this.mounted.push(...routers)
    return this
  }

  use(...args: unknown[]): this {
    assertOpen(this.#open, 'use')
    const parsed = parseUse<unknown>(args[0] as never, args[1] as never, args[2] as never, args.length)
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  useFn(...args: unknown[]): this {
    assertOpen(this.#open, 'useFn')
    const parsed = parseUse<unknown>(args[0] as never, args[1] as never, args[2] as never, args.length)
    this.#middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }
}

/**
 * Whether `server`, a plugin's `context.server`, is a server's own scope, its `.with(...)`, rather than a router's or a
 * controller's: a request no route matches runs that scope's hooks alone.
 */
export function isServerScope(server: ScopedServer<any>): boolean {
  const slot = server instanceof PluginSlot ? server : EntryServer.slotOf(server)
  return slot !== undefined && !slot.nested
}

/** One plugin's `context.server`: its slot's, open only while that plugin registers. */
class EntryServer implements ScopedServer<any> {
  readonly #slot: PluginSlot
  #open = true

  constructor(slot: PluginSlot) {
    this.#slot = slot
  }

  static slotOf(server: ScopedServer<any>): PluginSlot | undefined {
    return server instanceof EntryServer ? server.#slot : undefined
  }

  get name(): string | undefined {
    return this.#slot.name
  }

  get basePath(): string {
    return this.#slot.basePath
  }

  get prefix(): string {
    return this.#slot.prefix
  }

  get matcher(): RouteMatcherFactory {
    return this.#slot.matcher
  }

  get address(): ServerAddress | undefined {
    return this.#slot.address
  }

  close(): void {
    this.#open = false
  }

  hook<K extends HookName>(name: K, fn: HookFn<K, any>): this {
    assertOpen(this.#open, 'hook')
    this.#slot.hook(name, fn)
    return this
  }

  hasPlugin(name: string): boolean {
    assertOpen(this.#open, 'hasPlugin')
    return this.#slot.hasPlugin(name)
  }

  mount(...routers: AnyRouter[]): this {
    assertOpen(this.#open, 'mount')
    this.#slot.mount(...routers)
    return this
  }

  use(...args: unknown[]): this {
    assertOpen(this.#open, 'use')
    this.#slot.use(...args)
    return this
  }

  useFn(...args: unknown[]): this {
    assertOpen(this.#open, 'useFn')
    this.#slot.useFn(...args)
    return this
  }
}

function slotClosed(operation: Operation): ErrConfiguration {
  const message = errMessage(
    `Cannot call "server.${operation}" here: a plugin's server operations are open only while it registers`,
  ).solutions(
    'Call it from a ".with(...)" factory or from "HTTPPlugin.register", on a server, a router or a controller',
  )

  return new ErrConfiguration(message.reference('@caffeinejs/http', ErrConfiguration).build())
}

function assertOpen(open: boolean, operation: Operation): void {
  if (!open) {
    throw slotClosed(operation)
  }
}
