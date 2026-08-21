import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileProvider } from '../../providers/file_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }
const tmp: string[] = []

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, content, 'utf8')
  tmp.push(path)
  return path
}

afterEach(async () => {
  for (const f of tmp.splice(0)) {
    await unlink(f).catch(() => undefined)
  }
})

describe('FileProvider', () => {
  it('loads a JSON file and flattens nested keys', async () => {
    const path = await writeTmp('test-config.json', JSON.stringify({ db: { host: 'localhost', port: 5432 } }))
    const provider = new FileProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('db.host')?.value).toBe('localhost')
    expect(source.entries.get('db.port')?.value).toBe(5432)
  })

  it('indexes array fields when flattening JSON', async () => {
    const path = await writeTmp('array-config.json', JSON.stringify({ tags: ['a', 'b'], items: [{ id: 1 }] }))
    const provider = new FileProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('tags.0')?.value).toBe('a')
    expect(source.entries.get('tags.1')?.value).toBe('b')
    expect(source.entries.get('items.0.id')?.value).toBe(1)
    expect(source.entries.has('tags')).toBe(false)
  })

  it('sets origin with file: prefix', async () => {
    const path = await writeTmp('origin-test.json', JSON.stringify({ key: 'val' }))
    const provider = new FileProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('key')?.origin).toContain('file:')
  })

  it('throws for unknown file extension', async () => {
    const path = await writeTmp('config.toml', 'key = "value"')
    const provider = new FileProvider(path)
    await expect(provider.load(ctx)).rejects.toThrow('no parser registered')
  })
})
