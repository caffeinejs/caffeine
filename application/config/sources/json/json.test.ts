import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ConfigLoadContext } from '../../types.js'
import { JSONConfigSource } from './json.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

function context(profiles: string[] = []): ConfigLoadContext {
  return { profiles, signal: new AbortController().signal, logger: undefined as never }
}

describe('JSONConfigSource', () => {
  it('loads a JSON file as a tree, arrays included', async () => {
    const path = await write('app.json', { db: { host: 'localhost', port: 5432 }, tags: ['a', 'b'] })

    const [layer] = await new JSONConfigSource(path).load(context())

    expect(layer.name).toBe(`file:${path}`)
    expect(layer.data).toEqual({ db: { host: 'localhost', port: 5432 }, tags: ['a', 'b'] })
  })

  it('is named after its file unless told otherwise', () => {
    expect(new JSONConfigSource('./config/app.json').name).toBe('file:./config/app.json')
    expect(new JSONConfigSource('./config/app.json', { name: 'app' }).name).toBe('app')
  })

  it('takes a dotted key literally', async () => {
    const path = await write('dotted.json', { 'db.host': 'x' })

    const [layer] = await new JSONConfigSource(path).load(context())

    expect(layer.data).toEqual({ 'db.host': 'x' })
  })

  it('names the file, not just the syntax error, when the JSON is malformed', async () => {
    const path = await write('malformed.json', '{ "db": ')
    const source = new JSONConfigSource(path)

    await expect(source.load(context())).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_FILE_PARSE' })
    await expect(source.load(context())).rejects.toThrow(path)
  })

  it('skips a missing base file by default', async () => {
    await expect(new JSONConfigSource(join(dir, 'absent.json')).load(context())).resolves.toEqual([])
  })

  it('fails for a missing base file when it is not optional', async () => {
    await expect(
      new JSONConfigSource(join(dir, 'absent.json'), { optional: false }).load(context()),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // Absence and failure are different things: an optional file that is there but broken still fails.
  it('fails for a broken file even when the file is optional', async () => {
    const path = await write('broken.json', 'not json')

    await expect(new JSONConfigSource(path, { optional: true }).load(context())).rejects.toMatchObject({
      code: 'ERR_CONFIG_FILE_PARSE',
    })
  })

  it('does not ask the store to tolerate its failures', () => {
    expect(new JSONConfigSource('./app.json', { optional: true })).not.toHaveProperty('optional')
  })
})
