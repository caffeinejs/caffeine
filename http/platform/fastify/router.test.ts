import Fastify, { type FastifyServerOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../../core/error/common.js'
import type { WebApplication } from '../../index.js'
import { createWebApplication, newRouter } from './index.js'
import { routerFlagsOf, starParameterRefusal } from './router.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function flagsOf(factory: FastifyServerOptions) {
  app = createWebApplication().server(() => ({ factory })) as WebApplication
  await app.bootstrap()

  return routerFlagsOf(app.instance)
}

describe('routerFlagsOf', () => {
  // A plugin that matches paths as the router does reads these: one flag off is a path it matches differently.
  it("answers the router's defaults on a server that sets none", async () => {
    expect(await flagsOf({})).toEqual({
      caseSensitive: true,
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      useSemicolonDelimiter: false,
    })
  })

  // `initialConfig` reports `useSemicolonDelimiter: false` under `routerOptions` here, while the router reads `;`.
  it('keeps a top-level flag that routerOptions leaves out', async () => {
    const flags = await flagsOf({ useSemicolonDelimiter: true, routerOptions: { caseSensitive: false } })

    expect(flags.useSemicolonDelimiter).toBe(true)
    expect(flags.caseSensitive).toBe(false)
  })

  it('takes a flag routerOptions sets over the top-level one', async () => {
    const flags = await flagsOf({ ignoreDuplicateSlashes: true, routerOptions: { ignoreDuplicateSlashes: false } })

    expect(flags.ignoreDuplicateSlashes).toBe(false)
  })

  // Its options are Fastify's alone to know: an answer would be a guess.
  it('refuses a server the adapter did not build', async () => {
    const server = Fastify()

    try {
      expect(() => routerFlagsOf(server)).toThrow(ErrConfiguration)
    } finally {
      await server.close()
    }
  })
})

describe('a route with a parameter named *', () => {
  async function bootstrapWith(url: string) {
    app = createWebApplication().mount(newRouter().get(url, () => 'answer')) as WebApplication

    return app.bootstrap().catch((err: unknown) => err)
  }

  // find-my-way gives such a parameter the wildcard's name: whoever reads params['*'] could not tell the two apart.
  it('fails start-up, naming the route', async () => {
    const err = await bootstrapWith('/assets/:*')

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect((err as Error).message.split('\n')[0]).toBe(
      'Cannot register "/assets/:*": a parameter named "*" reads as a wildcard, whose value has that name',
    )
  })

  it('fails start-up on one after another parameter in a segment', async () => {
    expect(await bootstrapWith('/a/:x-:*')).toBeInstanceOf(ErrConfiguration)
  })

  it('leaves a wildcard and a named parameter alone', async () => {
    expect(await bootstrapWith('/assets/:name/*')).toBe(undefined)
  })

  // An escaped colon is text, and a parameter's regular expression is the parameter's, whatever it holds.
  it.each([['/a::*'], ['/files/:name(^[a-z]+:*$)'], ['/files/:name(^\\(:*\\)$)'], ['/files/:name(:*']])(
    'reads no parameter named * in %s',
    url => {
      expect(starParameterRefusal(url)).toBe(undefined)
    },
  )
})
