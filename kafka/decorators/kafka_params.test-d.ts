import { $k, KafkaParams, type Picks } from '../index.js'

/**
 * What `@KafkaParams` takes has a name a listener can write, so picks built apart from the decorator keep their
 * type. Nothing at run time checks it, so `npm run test:typecheck` is the test.
 */

const picks: Picks = [$k.value(), $k.key(), $k.header('trace')]

class Orders {
  @KafkaParams(picks)
  onOrder(_order: unknown, _key: string, _trace: string): void {}
}

void Orders
