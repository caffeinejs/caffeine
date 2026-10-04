import { expect, it } from 'vitest'

/**
 * Without a global `Symbol.metadata`, as on Node 24, tsc's decorator emit hands every decorator
 * `context.metadata === undefined`, and fetchy's registries are keyed by that object: the class fails to define. So
 * every entry point has to install the polyfill before a decorated class is evaluated, `./decorators` included. And it
 * has to install the registered symbol, the one di's polyfill and the SWC and Babel helpers use, so that whichever
 * loads first, they all agree.
 *
 * Nothing is imported statically, so the decorators entry is the only thing that can install it. Vitest runs each test
 * file in its own worker, so no other file installs it first.
 */
it('installs the registered Symbol.metadata when only the decorators entry is loaded', async () => {
  const before = (Symbol as { metadata?: symbol }).metadata

  await import('../decorators/index.js')

  expect((Symbol as { metadata?: symbol }).metadata).toBe(before ?? Symbol.for('Symbol.metadata'))
})
