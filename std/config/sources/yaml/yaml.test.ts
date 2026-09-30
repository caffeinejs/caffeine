import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../../load.js'
import { passthroughConfigSchema } from '../../schema.js'
import type { ConfigDefinition, ConfigLoadContext, ConfigSource } from '../../types.js'
import { YAMLConfigSource } from './yaml.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, ...lines: string[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function context(profiles: string[] = []): ConfigLoadContext {
  return { profiles, signal: new AbortController().signal, logger: undefined as never }
}

function definition(...sources: ConfigSource[]): ConfigDefinition {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

async function names(path: string): Promise<string[]> {
  return (await new YAMLConfigSource(path).load(context())).map(layer => layer.name)
}

describe('YAMLConfigSource documents', () => {
  // A file split by `---` means what its documents would mean as sources registered in that order.
  it('applies the documents of a file in order, a later one winning', async () => {
    const path = await write(
      'app.yaml',
      'region: eu',
      'db: { host: localhost, port: 5432 }',
      '---',
      'region: us',
      'db: { port: 6432 }',
    )

    const store = await loadConfig(definition(new YAMLConfigSource(path)))

    expect(store.current).toEqual({ region: 'us', db: { host: 'localhost', port: 6432 } })
    expect(store.explain('region')).toMatchObject({
      layers: [
        { layer: `file:${path}#2`, value: 'us' },
        { layer: `file:${path}#1`, value: 'eu' },
      ],
    })
  })

  it('reads a file of one document as one layer, named after the file', async () => {
    const path = await write('app.yaml', 'region: eu')

    expect(await new YAMLConfigSource(path).load(context())).toEqual([
      { name: `file:${path}`, data: { region: 'eu' }, interpolate: true },
    ])
  })

  // An empty document is a stray separator, not a value: it adds nothing, and the others keep their place in the file.
  it('skips an empty document, and names the others by their place in the file', async () => {
    const middle = await write('middle.yaml', 'a: 1', '---', '---', 'b: 2')
    const trailing = await write('trailing.yaml', 'a: 1', '---')

    expect(await names(middle)).toEqual([`file:${middle}#1`, `file:${middle}#3`])
    // One document holds anything, so the file keeps its plain name.
    expect(await names(trailing)).toEqual([`file:${trailing}`])
  })

  it('adds nothing for a file that holds only comments', async () => {
    const path = await write('app.yaml', '# Nothing here yet.')

    expect(await new YAMLConfigSource(path).load(context())).toEqual([])
  })

  // A scalar or a list at the top of a document would otherwise merge as a set of nonsense keys.
  it('refuses a document that is not a mapping, naming the file and the document', async () => {
    const path = await write('app.yaml', 'a: 1', '--- 42')

    const error = await new YAMLConfigSource(path).load(context()).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(`Cannot parse config file "${path}": document 2 is a number`)
  })

  // As with a profile file, a placeholder that loses the merge is never filled in: a secret reference a later
  // document overrides must not demand a variable nobody sets.
  it('never needs a placeholder a later document overrides', async () => {
    vi.stubEnv('DB_PASSWORD', undefined)
    const path = await write('app.yaml', "db: { password: '${env:DB_PASSWORD}' }", '---', 'db: { password: dev }')

    const store = await loadConfig(definition(new YAMLConfigSource(path)))

    expect(store.current).toEqual({ db: { password: 'dev' } })
  })

  it('names the document a malformed placeholder is in', async () => {
    const path = await write('app.yaml', 'a: 1', '---', "b: '${evn:NAME}'")

    await expect(new YAMLConfigSource(path).load(context())).rejects.toThrow(
      `Cannot interpolate "b" in config file "${path}#2": the placeholder at character 1 has a prefix other than "env" or "config"`,
    )
  })

  // A profile file may hold documents too: they apply after every document of the base file, in their own order.
  it('reads the documents of a profile file after those of the base file', async () => {
    const path = await write('app.yaml', 'a: base', '---', 'b: base')
    const dev = await write('app-dev.yaml', 'a: dev', '---', 'c: dev')

    const layers = await new YAMLConfigSource(path).load(context(['dev']))

    expect(layers.map(({ name, profile }) => [name, profile])).toEqual([
      [`file:${path}#1`, undefined],
      [`file:${path}#2`, undefined],
      [`file:${dev}#1`, 'dev'],
      [`file:${dev}#2`, 'dev'],
    ])
  })

  // A line of a config file may hold a secret, so the error points at it without quoting it.
  it('names the file and the line of a YAML error in any document, never the text', async () => {
    const path = await write('app.yaml', 'a: 1', '---', 'password: "hunter2')

    const error = await new YAMLConfigSource(path).load(context()).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(`Cannot parse config file "${path}"`)
    expect((error as Error).message).toMatch(/at line \d+, column \d+/)
    expect((error as Error).message).not.toContain('hunter2')
  })

  // Read as text instead, a value tagged for something the parser does not know would be wrong without a word.
  it('refuses a warning, such as a tag nothing resolves', async () => {
    const path = await write('app.yaml', 'timeout: !duration 5s')

    const error = await new YAMLConfigSource(path).load(context()).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(`Cannot parse config file "${path}": Unresolved tag: !duration`)
  })
})
