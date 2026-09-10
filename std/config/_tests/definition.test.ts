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
  // `profiles` is the only way a hand-built definition — the form `ConfigModule` requires — states its active
  // profiles. It has to reach the engine on the one and only resolve: a second entry here would mean a source
  // was loaded twice to work out what the first load should have asked for.
  it('forwards stated profiles on a single resolve', async () => {
    const seen: ResolutionContext[] = []

    const definition = new ConfigDefinition()
    definition.schema = passthroughConfigSchema
    definition.profiles = ['prod']
    definition.sources.add(spy(seen))

    await definition.bootstrap()

    expect(seen).toEqual([{ profiles: ['prod'] }])
  })

  it('resolves with no profile when none were stated', async () => {
    const seen: ResolutionContext[] = []

    const definition = new ConfigDefinition()
    definition.schema = passthroughConfigSchema
    definition.sources.add(spy(seen))

    await definition.bootstrap()

    expect(seen).toEqual([{ profiles: [] }])
  })
})
