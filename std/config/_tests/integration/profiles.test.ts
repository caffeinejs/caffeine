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

describe('profile selection', () => {
  // The regression this design exists for. Deciding the profiles before anything resolves is what lets every
  // source load exactly once; the previous shape probed the whole chain, read `caffeine.profiles` off the
  // result, and then resolved the whole chain again — twice the remote fetches, at boot and on every refresh.
  it('loads every source exactly once, profile or no profile', async () => {
    const base = await writeTmp('sel-count.json', JSON.stringify({ caffeine: { profiles: ['dev'] } }))
    await writeTmp('sel-count-dev.json', JSON.stringify({ a: 1 }))
    const load = vi.spyOn(FileConfigProvider.prototype, 'load')

    await bootstrapConfig({
      sources: ConfigSources.of(new JSONConfigProvider(base)),
      schema: passthroughConfigSchema,
    })

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a base file selects its own overlay from the caffeine.profiles it declares', async () => {
    const base = await writeTmp(
      'sel-app.json',
      JSON.stringify({ caffeine: { profiles: 'prod' }, db: { host: 'base' } }),
    )
    await writeTmp('sel-app-prod.json', JSON.stringify({ db: { host: 'prod' } }))

    const result = await bootstrapConfig({
      sources: ConfigSources.of(new FileConfigProvider(base, text => JSON.parse(text) as Record<string, unknown>)),
      schema: passthroughConfigSchema,
    })

    expect(result.materialized['db']).toEqual({ host: 'prod' })
  })

  // Named up front — the container's own set, `--caffeine.profiles`, `CAFFEINE__PROFILES` — and the base
  // file does not get a second vote on which overlay applies.
  it('stated profiles win over the caffeine.profiles the base file declares', async () => {
    const base = await writeTmp(
      'sel-stated.json',
      JSON.stringify({ caffeine: { profiles: ['dev'] }, db: { host: 'base' } }),
    )
    await writeTmp('sel-stated-dev.json', JSON.stringify({ db: { host: 'dev' } }))
    await writeTmp('sel-stated-eu.json', JSON.stringify({ db: { host: 'eu' } }))

    const result = await bootstrapConfig({
      sources: ConfigSources.of(new JSONConfigProvider(base)),
      schema: passthroughConfigSchema,
      profiles: ['eu'],
    })

    expect(result.materialized['db']).toEqual({ host: 'eu' })
  })

  // A value that only exists after a resolve cannot decide what that resolve reads. An inline source still
  // lands in the tree; it simply selects nothing.
  it('an inline caffeine.profiles selects no overlay', async () => {
    const base = await writeTmp('sel-inline.json', JSON.stringify({ db: { host: 'base' } }))
    await writeTmp('sel-inline-eu.json', JSON.stringify({ db: { host: 'eu' } }))

    const result = await bootstrapConfig({
      sources: ConfigSources.of(
        new InlineConfigProvider({ caffeine: { profiles: ['eu'] } }),
        new JSONConfigProvider(base),
      ),
      schema: passthroughConfigSchema,
    })

    expect(result.materialized['db']).toEqual({ host: 'base' })
  })

  it('deduplicates the stated profiles before any provider sees them', async () => {
    const seen: (readonly string[])[] = []
    const spy: ConfigProvider = {
      id: 'spy',
      load: (ctx: ResolutionContext) => {
        seen.push(ctx.profiles)
        return Promise.resolve([])
      },
    }

    await bootstrapConfig({
      sources: ConfigSources.of(spy),
      schema: passthroughConfigSchema,
      profiles: ['eu', 'dev', 'eu'],
    })

    expect(seen).toEqual([['eu', 'dev']])
  })
})
