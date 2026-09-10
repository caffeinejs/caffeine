import { describe, expect, it } from 'vitest'

import type { ConfigProvider, ResolutionContext } from '../config.js'
import { ConfigDefinition } from '../definition.js'
import { passthroughConfigSchema } from '../schema.js'

function spy(seen: ResolutionContext[]): ConfigProvider {
  return {
    id: 'spy',
    load: async ctx => {
      seen.push({ profiles: [...ctx.profiles] })
      return []
    },
  }
}

describe('ConfigDefinition', () => {
  // `profiles` is the only way a hand-built definition — the form `ConfigModule` now requires — states its
  // active profiles outright. It must reach the engine, and it must suppress the `profilesPath` two-phase
  // discovery: a probe pass would show up here as a leading resolve with an empty profile list.
  it('forwards stated profiles and skips profilesPath discovery', async () => {
    const seen: ResolutionContext[] = []

    const definition = new ConfigDefinition()
    definition.schema = passthroughConfigSchema
    definition.profiles = ['prod']
    definition.profilesPath = ['caffeine', 'profiles']
    definition.sources.add(spy(seen))

    await definition.bootstrap()

    expect(seen).toEqual([{ profiles: ['prod'] }])
  })

  it('falls back to profilesPath discovery when no profiles are stated', async () => {
    const seen: ResolutionContext[] = []

    const definition = new ConfigDefinition()
    definition.schema = passthroughConfigSchema
    definition.profilesPath = ['caffeine', 'profiles']
    definition.sources.add(spy(seen))

    await definition.bootstrap()

    // One probe with no profile; nothing declared one, so the probe result is reused rather than resolved again.
    expect(seen).toEqual([{ profiles: [] }])
  })
})
