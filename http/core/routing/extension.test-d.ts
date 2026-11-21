import { type AnyRouteExtension, Router } from '../../index.js'

// A package describing routes it does not own writes one helper both a router and a route take. `npm run
// test:typecheck` is the test.

function hidden(): AnyRouteExtension {
  return (target: { detail(key: 'http', value: { internal: boolean }): unknown }) => {
    target.detail('http', { internal: true })
  }
}

new Router('/a')
  .extend(hidden())
  .get('/')
  .extend(hidden())
  .handler(() => 'a')
