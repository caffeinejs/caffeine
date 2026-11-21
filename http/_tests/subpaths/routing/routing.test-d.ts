import { Router } from '@caffeinejs/http/routing'

// A consumer of `@caffeinejs/http/routing` alone, in a program of its own: no plugin's field is in sight, so this is
// where a route's options must still refuse what is not an options object. `npm run test:typecheck` is the test.

// @ts-expect-error a number is not an options input
new Router('/a').get('/').options(42)

// @ts-expect-error a key no plugin declared
new Router('/a').routeOptions({ unknownPluginKey: true })
