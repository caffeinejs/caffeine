import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { InlineConfigSource } from '../sources/inline_source.js'
import { JSONConfigSource } from '../sources/json_source.js'
import type { ConfigLoadContext, ConfigSource } from '../types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-profiles-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

function definition(sources: ConfigSource[]) {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

describe('profile selection', () => {
  // Deciding the profiles before anything loads is what lets every source load exactly once.
  it('loads every source exactly once, profile or no profile', async () => {
    const base = await write('count.json', { a: 0 })
    await write('count-dev.json', { a: 1 })
    const load = vi.spyOn(JSONConfigSource.prototype, 'load')

    const store = await loadConfig(definition([new JSONConfigSource(base)]), { profiles: ['dev'] })

    expect(load).toHaveBeenCalledTimes(1)
    expect((store.current as { a: unknown }).a).toBe(1)
  })

  // Only the profiles named up front select files. A base file's own `caffeine.profiles` is an ordinary key: the
  // overlay it would pick is one no other source, and no bean, would follow.
  it('selects nothing from the caffeine.profiles a base file declares', async () => {
    const base = await write('app.json', { caffeine: { profiles: ['prod'] }, db: { host: 'base' } })
    await write('app-prod.json', { db: { host: 'prod' } })
    await write('app-eu.json', { db: { host: 'eu' } })

    const unnamed = await loadConfig(definition([new JSONConfigSource(base)]))
    const named = await loadConfig(definition([new JSONConfigSource(base)]), { profiles: ['eu'] })

    expect((unnamed.current as { db: unknown }).db).toEqual({ host: 'base' })
    expect((named.current as { db: unknown }).db).toEqual({ host: 'eu' })
  })

  // A value that only exists after a load cannot decide what that load reads. It still lands in the tree.
  it('selects no overlay from a caffeine.profiles another source carries', async () => {
    const base = await write('inline.json', { db: { host: 'base' } })
    await write('inline-eu.json', { db: { host: 'eu' } })

    const store = await loadConfig(
      definition([new InlineConfigSource({ caffeine: { profiles: ['eu'] } }), new JSONConfigSource(base)]),
    )

    expect((store.current as { db: unknown }).db).toEqual({ host: 'base' })
  })

  it('deduplicates the profiles before any source sees them', async () => {
    const seen: (readonly string[])[] = []
    const spy: ConfigSource = {
      name: 'spy',
      load: (context: ConfigLoadContext) => {
        seen.push(context.profiles)
        return []
      },
    }

    await loadConfig(definition([spy]), { profiles: ['eu', 'dev', 'eu'] })

    expect(seen).toEqual([['eu', 'dev']])
  })

  it('reports the profiles it loaded with', async () => {
    const store = await loadConfig(definition([]), { profiles: ['eu'] })

    expect(store.inspect().profiles).toEqual(['eu'])
  })
})
