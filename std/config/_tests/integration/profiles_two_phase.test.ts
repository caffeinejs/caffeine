import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { bootstrapConfig } from '../../bootstrap.js'
import type { ConfigProvider, ResolutionContext } from '../../config.js'
import { FileConfigProvider } from '../../providers/file_provider.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import { JSONConfigProvider } from '../../providers/json_provider.js'
import { passthroughConfigSchema } from '../../schema.js'
import { ConfigSources } from '../../sources.js'

const PROFILES_PATH = ['caffeine', 'profiles'] as const
const tmp: string[] = []

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, content, 'utf8')
  tmp.push(path)
  return path
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of tmp.splice(0)) {
    await unlink(f).catch(() => undefined)
  }
})

describe('two-phase profile discovery', () => {
  it('a profile named by another source selects the matching file overlay', async () => {
    // The whole point: `caffeine.profiles` set from an ordinary source — here inline, but env or args are the
    // real cases — must decide which `-<profile>` file the file provider layers on, even though that value is
    // itself only known after a resolve.
    const base = await writeTmp('tp-app.json', JSON.stringify({ db: { host: 'base' } }))
    await writeTmp('tp-app-prod.json', JSON.stringify({ db: { host: 'prod' } }))

    const result = await bootstrapConfig({
      sources: ConfigSources.of(
        new InlineConfigProvider({ caffeine: { profiles: 'prod' } }),
        new FileConfigProvider(base, text => JSON.parse(text) as Record<string, unknown>),
      ),
      schema: passthroughConfigSchema,
      profilesPath: PROFILES_PATH,
    })

    expect(result.materialized['db']).toEqual({ host: 'prod' })
  })

  it('resolves once when no profile is declared, twice when one is', async () => {
    const base = await writeTmp('tp-count.json', JSON.stringify({ a: 1 }))
    const load = vi.spyOn(FileConfigProvider.prototype, 'load')

    await bootstrapConfig({
      sources: ConfigSources.of(new JSONConfigProvider(base)),
      schema: passthroughConfigSchema,
      profilesPath: PROFILES_PATH,
    })
    expect(load).toHaveBeenCalledTimes(1)

    load.mockClear()

    await bootstrapConfig({
      sources: ConfigSources.of(
        new InlineConfigProvider({ caffeine: { profiles: ['dev'] } }),
        new JSONConfigProvider(base),
      ),
      schema: passthroughConfigSchema,
      profilesPath: PROFILES_PATH,
    })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('deduplicates the discovered profiles before any provider sees them', async () => {
    const seen: (readonly string[])[] = []
    const spy: ConfigProvider = {
      id: 'spy',
      load: (ctx: ResolutionContext) => {
        seen.push(ctx.profiles)
        return Promise.resolve([])
      },
    }

    await bootstrapConfig({
      sources: ConfigSources.of(new InlineConfigProvider({ caffeine: { profiles: ['eu', 'dev', 'eu'] } }), spy),
      schema: passthroughConfigSchema,
      profilesPath: PROFILES_PATH,
    })

    expect(seen.at(-1)).toEqual(['eu', 'dev'])
  })
})
