import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from './core/error/common.js'
import { HookBatch } from './core/lifecycle/batch.js'
import { assertHookName, HOOK_NAMES, type HookFn, type HookName } from './core/lifecycle/lifecycle.js'
import type { RouterFlags } from './core/matcher/matcher.js'
import { parseUse } from './core/middleware/middleware.js'
import { MiddlewarePipeline } from './core/middleware/pipeline.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import { configurationError } from './core/server/error.js'
import { HTTPPlugin, type HTTPSetupContext, type SlotServer, type WebApplicationOps } from './plugin.js'

type Operation = 'mount' | 'use' | 'useFn' | 'hook' | 'hasPlugin'

/**
 * `context.app` for one plugin slot. What is mounted is recorded in {@link mounted} for whoever owns the slot to
 * serve, and middleware goes into the pipeline it was given. Every call is refused unless {@link during} is running,
 * so a context kept past its slot is refused whether the slot finished or failed.
 */
export class PluginSlot implements WebApplicationOps<any> {
  /** What was mounted while the slot was open, in call order. */
  readonly mounted: AnyRouter[] = []

  readonly #middlewares: MiddlewarePipeline
  readonly #mountable: boolean
  /** The names of the plugins claimed in this slot so far. */
  readonly #names = new Set<string>()
  #open = false
  /** Where `hook(...)` adds: the batch of the slot entry running now. */
  #batch: HookBatch | undefined
  #server: SlotServer | undefined

  /** @param mountable - `false` for a controller's slot: a class has no children to nest routers under. */
  constructor(middlewares: MiddlewarePipeline = new MiddlewarePipeline(), mountable = true) {
    this.#middlewares = middlewares
    this.#mountable = mountable
  }

  /** @see {@link WebApplicationOps.server} */
  get server(): SlotServer | undefined {
    return this.#server
  }

  /** Marks this slot as a server's. Called once, before the slot opens. */
  forServer(basePath: string, router: RouterFlags | undefined): void {
    this.#server = { basePath, router }
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
   * Resolves to the hooks the entry added.
   *
   * @throws ErrConfiguration when the factory produced no `HTTPPlugin`, or a plugin name already claimed here.
   */
  async run(
    factory: (context: HTTPSetupContext) => unknown,
    context: HTTPSetupContext,
    where: string,
  ): Promise<HookBatch> {
    const batch = new HookBatch(context)
    this.#batch = batch

    try {
      const plugin = await factory(context)

      if (!(plugin instanceof HTTPPlugin)) {
        throw configurationError(
          `Cannot install a server plugin ${where}: only an HTTPPlugin can be installed`,
          'Return an HTTPPlugin instance from the factory given to ".with(...)" or "@Use(...)"',
        )
      }

      batch.name = plugin.name
      this.claim(plugin, where)
      await plugin.register(context)

      return batch
    } finally {
      this.#batch = undefined
    }
  }

  /**
   * Records `plugin`'s name in this slot.
   *
   * @throws ErrConfiguration for an empty name, or one already claimed here.
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

    if (this.#names.has(name)) {
      throw new ErrConfiguration(
        errMessage(`Cannot register plugin "${name}" twice ${where}`)
          .solutions(`Remove the second .with(...) that registers plugin "${name}" ${where}`)
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

    assertHookName(name, HOOK_NAMES, 'with context.app.hook')
    this.#batch.add(name, fn as HookFn<K>)
    return this
  }

  hasPlugin(name: string): boolean {
    this.#assertOpen('hasPlugin')
    return this.#names.has(name)
  }

  mount(...routers: AnyRouter[]): this {
    this.#assertOpen('mount')

    if (!this.#mountable) {
      throw new ErrConfiguration(
        errMessage('Cannot call "app.mount" from a controller\'s plugin: routers nest only under a router')
          .solutions(
            'Mount them from a router\'s plugin, registered with "router.with(...)"',
            'Or from a plugin registered with ".with(...)" on the application or a listener',
          )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.mounted.push(...routers)
    return this
  }

  use(...args: unknown[]): this {
    this.#assertOpen('use')
    const parsed = parseUse<unknown>(args[0] as never, args[1] as never, args[2] as never, args.length)
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  useFn(...args: unknown[]): this {
    this.#assertOpen('useFn')
    const parsed = parseUse<unknown>(args[0] as never, args[1] as never, args[2] as never, args.length)
    this.#middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }

  #assertOpen(operation: Operation): void {
    if (!this.#open) {
      throw slotClosed(operation)
    }
  }
}

/** The `app` of a context handed out outside every plugin slot: every operation refuses. */
export function closedApplicationOps(): WebApplicationOps {
  return new PluginSlot()
}

function slotClosed(operation: Operation): ErrConfiguration {
  const message = errMessage(
    `Cannot call "app.${operation}" here: the application's operations are open only to a plugin while it ` +
      'registers',
  ).solutions(
    'Call it from a ".with(...)" factory or from "HTTPPlugin.register", on the application, a listener or a ' +
      'router',
  )

  return new ErrConfiguration(message.reference('@caffeinejs/http', ErrConfiguration).build())
}
