import { $m, MessageParams, type Picks } from '../index.js'

/**
 * What `@MessageParams` takes has a name a consumer can write, so picks built apart from the decorator keep their
 * type. Nothing at run time checks it, so `npm run test:typecheck` is the test.
 */

const picks: Picks = [$m.payload(), $m.header('trace'), $m.context()]

// @ts-expect-error — a name is not a pick.
const _named: Picks = ['payload']

class Orders {
  @MessageParams(picks)
  onOrder(_order: unknown, _trace: unknown, _ctx: unknown): void {}
}

void Orders
