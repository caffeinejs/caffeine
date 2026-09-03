import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { Keys } from './symbols.js'

// `@KafkaHandler` classes register globally like `@Controller`. `@Profile` is the built-in way to scope which
// handlers a given application actually wires — no kafka-specific mechanism needed.
@KafkaHandler()
@Profile('kafka')
class ProfiledConsumer {
  @KafkaListener({ topic: 't' })
  on(): void {}
}

function isWired(container: CaffeineIoC): boolean {
  return container.getBindingsByLabel(Keys.KAFKA_HANDLER).some(d => d.binding.type === ProfiledConsumer)
}

describe('@KafkaHandler + @Profile', () => {
  it('does not wire a profiled handler when the profile is inactive', () => {
    expect(isWired(new CaffeineIoC())).toBe(false)
  })

  it('wires a profiled handler when the profile is active', () => {
    expect(isWired(new CaffeineIoC({ profiles: ['kafka'] }))).toBe(true)
  })
})
