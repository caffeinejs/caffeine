import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from './index.js'

describe('generate run()', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true })
    }
  })

  async function project(config: unknown): Promise<string> {
    const dir = join(tmpdir(), `caffeine-test-${randomUUID()}`)
    dirs.push(dir)
    await mkdir(join(dir, 'src/orders'), { recursive: true })
    await Bun.write(join(dir, 'src/orders/order.ts'), '@Injectable()\nexport class Order {}\n')
    await Bun.write(join(dir, '.caffeinerc.ts'), `export default ${JSON.stringify(config)}\n`)
    return dir
  }

  it('rejects a missing kind', async () => {
    const dir = await project({ modules: { include: ['src/**/*.ts'], root: 'src' } })
    await expect(run({ cwd: dir })).rejects.toThrow('Cannot generate: missing kind')
  })

  it('rejects an unknown kind', async () => {
    const dir = await project({ modules: { include: ['src/**/*.ts'], root: 'src' } })
    await expect(run({ cwd: dir, kind: 'routes' })).rejects.toThrow('Cannot generate: unknown kind "routes"')
  })

  it('rejects a config without a modules section', async () => {
    const dir = await project({})
    await expect(run({ cwd: dir, kind: 'modules' })).rejects.toThrow('config does not define "modules"')
  })

  it('generates the module graph for kind modules', async () => {
    const dir = await project({ modules: { include: ['src/**/*.ts'], root: 'src' } })
    await run({ cwd: dir, kind: 'modules' })
    expect(await Bun.file(join(dir, 'src/root.generated.mod.ts')).exists()).toBe(true)
  })
})
