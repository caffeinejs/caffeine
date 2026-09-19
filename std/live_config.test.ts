import { CaffeineIoC, Injectable, token } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'

import type { ConfigSource, InferConfig } from './config/index.js'
import { createApplication, newConfiguration } from './index.js'
import { $t } from './schema/t.js'

const schema = $t.Object({ pricing: $t.Object({ margin: $t.Number() }) })
type AppConfig = InferConfig<typeof schema>
const kConfig = token<AppConfig>(Symbol('app.config'))

// The feature the whole package exists for, end to end: a live source changes a part of the tree, and a service
// that was handed the configuration once reads the new value, with nobody calling a refresh.
describe('live configuration', () => {
  it('reaches a singleton through the config object it was injected with', async () => {
    @Injectable([kConfig])
    class Pricing {
      constructor(private readonly config: AppConfig) {}

      quote(): number {
        return this.config.pricing.margin
      }
    }

    // A source that says when it changed. Nothing below asks for a reload: the store loads it again by itself.
    let margin = 0.2
    let changed: (() => void) | undefined
    const overrides: ConfigSource = {
      name: 'overrides',
      load: () => [{ name: 'overrides', data: { pricing: { margin } } }],
      watch: listener => {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    }
    const conf = newConfiguration(schema, kConfig).source(overrides).build()
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Pricing, t => t.toSelf())
    const app = createApplication({ container, config: conf })
    await app.ready()

    const pricing = app.container.get(Pricing)
    expect(pricing.quote()).toBe(0.2)

    margin = 0.35
    changed?.()

    await vi.waitFor(() => expect(pricing.quote()).toBe(0.35))
    expect(app.container.get(Pricing)).toBe(pricing)

    await app.close()
  })
})
