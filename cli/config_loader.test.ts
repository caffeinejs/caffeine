import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from './config_loader.js'

describe('loadConfig()', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true })
    }
  })

  async function project(files: Record<string, string>): Promise<string> {
    const dir = join(tmpdir(), `caffeine-test-${randomUUID()}`)
    dirs.push(dir)
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) {
      await Bun.write(join(dir, name), text)
    }
    return dir
  }

  const MODULES = { include: ['src/**/*.ts'], root: 'src' }

  it('loads every supported extension', async () => {
    const module = `export default ${JSON.stringify({ modules: MODULES })}\n`
    const data = JSON.stringify({ modules: MODULES })
    const yaml = 'modules:\n  include: ["src/**/*.ts"]\n  root: src\n'

    for (const [name, text] of [
      ['.caffeinerc.ts', module],
      ['.caffeinerc.js', module],
      ['.caffeinerc.mjs', module],
      ['.caffeinerc.json', data],
      ['.caffeinerc.yaml', yaml],
      ['.caffeinerc.yml', yaml],
    ] as const) {
      const dir = await project({ [name]: text })
      expect(await loadConfig(dir), name).toEqual({ modules: MODULES })
    }
  })

  // A JSON-only or YAML-only project used to be unreachable: the loader probed the .ts candidate
  // first and rethrew bun's ERR_MODULE_NOT_FOUND instead of moving on to the next extension.
  it('finds a config when no TypeScript candidate exists', async () => {
    const dir = await project({ '.caffeinerc.json': JSON.stringify({ modules: MODULES }) })
    expect(await loadConfig(dir)).toEqual({ modules: MODULES })
  })

  it('prefers the earliest extension when several exist', async () => {
    const dir = await project({
      '.caffeinerc.ts': `export default ${JSON.stringify({ modules: { ...MODULES, root: 'from-ts' } })}\n`,
      '.caffeinerc.json': JSON.stringify({ modules: { ...MODULES, root: 'from-json' } }),
    })
    expect((await loadConfig(dir)).modules?.root).toBe('from-ts')
  })

  it('ignores an extensionless .caffeinerc', async () => {
    const dir = await project({ '.caffeinerc': JSON.stringify({ modules: MODULES }) })
    await expect(loadConfig(dir)).rejects.toThrow('Cannot find caffeine config')
  })

  it('accepts a $schema key in a data config', async () => {
    const dir = await project({
      '.caffeinerc.yaml':
        '$schema: ./node_modules/@caffeinejs/cli/caffeinerc.schema.json\nmodules:\n  include: ["src/**/*.ts"]\n',
    })
    expect((await loadConfig(dir)).modules?.include).toEqual(['src/**/*.ts'])
  })

  it('rejects a data config that does not match the schema', async () => {
    const badType = await project({ '.caffeinerc.yaml': 'modules:\n  include: ["src"]\n  depth: two\n' })
    await expect(loadConfig(badType)).rejects.toThrow('Cannot parse caffeine config')

    const unknownKey = await project({ '.caffeinerc.json': JSON.stringify({ modules: MODULES, nope: 1 }) })
    await expect(loadConfig(unknownKey)).rejects.toThrow('Cannot parse caffeine config')

    const missingInclude = await project({ '.caffeinerc.json': JSON.stringify({ modules: { root: 'src' } }) })
    await expect(loadConfig(missingInclude)).rejects.toThrow('Cannot parse caffeine config')
  })

  it('does not schema-check a TypeScript config, so moduleName stays usable', async () => {
    const dir = await project({
      '.caffeinerc.ts': "export default { modules: { include: ['src/**/*.ts'], moduleName: (n: string) => n } }\n",
    })
    expect(typeof (await loadConfig(dir)).modules?.moduleName).toBe('function')
  })

  it('loads an explicit config path', async () => {
    const dir = await project({ 'custom.config.json': JSON.stringify({ modules: MODULES }) })
    expect(await loadConfig(dir, 'custom.config.json')).toEqual({ modules: MODULES })
  })

  it('reports a missing explicit config path', async () => {
    const dir = await project({})
    await expect(loadConfig(dir, 'nope.json')).rejects.toThrow('Cannot find caffeine config: "nope.json"')
  })

  it('reports an unsupported explicit extension', async () => {
    const dir = await project({ 'config.toml': 'modules = {}\n' })
    await expect(loadConfig(dir, 'config.toml')).rejects.toThrow('unsupported extension ".toml"')
  })

  it('reports that no config exists', async () => {
    const dir = await project({})
    await expect(loadConfig(dir)).rejects.toThrow('.caffeinerc.{ts,js,mjs,json,yaml,yml}')
  })
})
