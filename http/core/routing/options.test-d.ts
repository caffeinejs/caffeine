import { expectTypeOf } from 'vitest'

import { Controller, cors, csrfExempt, RouteOptions, Router, type IContext } from '../../index.js'

// A plugin that declares its field without `?` must not make it required on every route, nor present on a route that
// never set it.
declare module './options.js' {
  interface RouteOptions {
    testRequired: { level: number }
  }
}

/**
 * What a route's options accept is checked against what the plugins declared: the built-in ones augment
 * `RouteOptions` from the package root, so `npm run test:typecheck` is the test.
 */

new Router('/a')
  .get('/')
  .options(cors(false), csrfExempt())
  .handler(() => 'a')

new Router('/a').routeOptions(cors({ origins: ['https://example.com'] }), { csrf: { exempt: true } })

// @ts-expect-error a path is not an options input
new Router('/a').get('/').options('x')

// @ts-expect-error a declared field takes its declared type
new Router('/a').get('/').options({ cors: 1 })

// @ts-expect-error a key no plugin declared is refused
new Router('/a').routeOptions({ unknownPluginKey: true })

new Router('/a').configType<{ greeting: string }>().routeOptions((o, { config }) => {
  expectTypeOf(config.greeting).toEqualTypeOf<string>()
  expectTypeOf(o).toEqualTypeOf<Partial<RouteOptions>>()
})

// The `Router.routeOptions` example, as written there.
new Router('/hooks').configType<{ webhooks: { strict: boolean } }>().routeOptions(cors(false), (o, { config }) => {
  o.csrf = { exempt: !config.webhooks.strict }
})

// The `@RouteOptions` example, as written there.
@Controller('/hooks')
@RouteOptions<{ webhooks: { strict: boolean } }>(cors(false), (o, { config }) => {
  o.csrf = { exempt: !config.webhooks.strict }
})
class Hooks {}
void Hooks

// A route that sets no options still type-checks, and reads a declared field as possibly absent.
new Router('/a').routeOptions({ cors: false }).get('/', (ctx: IContext) => {
  // @ts-expect-error the field may be absent: no route is made to set it
  return ctx.options.testRequired.level
})

// @ts-expect-error a configurer writes the options it is handed: a returned object would be dropped
new Router('/a').routeOptions(() => cors(false))

// @ts-expect-error a configurer is synchronous: nothing waits on a promise
new Router('/a').routeOptions(async () => undefined)

// A configurer a plugin declares apart from the call: its return type is inferred as `void`.
function closed(o: Partial<RouteOptions>) {
  o.cors = false
}
new Router('/a')
  .routeOptions(closed)
  .get('/')
  .options(closed)
  .handler(() => 'a')
