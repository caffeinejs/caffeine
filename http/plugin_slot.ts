import { errMessage } from '@caffeinejs/std/err'

import type { WebApplicationOps } from './adapter.js'
import { ErrConfiguration } from './core/error/common.js'
import { parseUse } from './core/middleware/middleware.js'
import { MiddlewarePipeline } from './core/middleware/pipeline.js'
import type { Router } from './core/routing/programmatic/programmatic.js'

type AnyRouter = Router<any, any, any, any, any, any>
type Operation = 'mount' | 'use' | 'useFn'

/**
 * `context.app` for one plugin slot. What is mounted is recorded in {@link mounted} for whoever owns the slot to
 * serve, and middleware goes into the pipeline it was given. Every call is refused unless {@link during} is running,
 * so a context kept past its slot is refused whether the slot finished or failed.
 */
export class PluginSlot implements WebApplicationOps<any, any> {
  /** What was mounted while the slot was open, in call order. */
  readonly mounted: AnyRouter[] = []

  readonly #middlewares: MiddlewarePipeline<string>
  readonly #mountable: boolean
  #open = false

  /** @param mountable - `false` for a controller's slot: a class has no children to nest routers under. */
  constructor(middlewares: MiddlewarePipeline<string> = new MiddlewarePipeline(), mountable = true) {
    this.#middlewares = middlewares
    this.#mountable = mountable
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
    const parsed = parseUse<unknown, string>(args[0] as never, args[1] as never, args[2] as never, args.length)
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  useFn(...args: unknown[]): this {
    this.#assertOpen('useFn')
    const parsed = parseUse<unknown, string>(args[0] as never, args[1] as never, args[2] as never, args.length)
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

  if (operation === 'mount') {
    message.solutions('A Fastify plugin body adds a group with "instance.$route(...)" instead')
  }

  return new ErrConfiguration(message.reference('@caffeinejs/http', ErrConfiguration).build())
}
