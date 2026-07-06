import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { scan } from './scanner.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'caffeine-scanner-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('scan() — decorator filter', () => {
  test('includes file with decorator', async () => {
    const dir = join(tmpDir, 'with-decorator')
    await mkdir(dir)
    await Bun.write(join(dir, 'a.ts'), '@Injectable() class A {}')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: [] })
    expect(result).toHaveLength(1)
    expect(result[0]).toEndWith('a.ts')
  })

  test('excludes file without decorator', async () => {
    const dir = join(tmpDir, 'no-decorator')
    await mkdir(dir)
    await Bun.write(join(dir, 'b.ts'), 'export const x = 1\n')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: [] })
    expect(result).toHaveLength(0)
  })

  test('excludes empty file', async () => {
    const dir = join(tmpDir, 'empty')
    await mkdir(dir)
    await Bun.write(join(dir, 'c.ts'), '')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: [] })
    expect(result).toHaveLength(0)
  })

  test('excludes file where @ appears only in a line comment', async () => {
    const dir = join(tmpDir, 'jsdoc')
    await mkdir(dir)
    await Bun.write(join(dir, 'd.ts'), '// @see Something\nexport class D {}')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: [] })
    expect(result).toHaveLength(0)
  })

  test('includes file with decorator near end of large content', async () => {
    const dir = join(tmpDir, 'large')
    await mkdir(dir)
    const preamble = '// ' + 'x'.repeat(5000) + '\n'
    await Bun.write(join(dir, 'e.ts'), preamble + '@Injectable() class E {}')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: [] })
    expect(result).toHaveLength(1)
    expect(result[0]).toEndWith('e.ts')
  })

  test('respects exclude globs', async () => {
    const dir = join(tmpDir, 'exclude')
    await mkdir(dir)
    await Bun.write(join(dir, 'f.ts'), '@Injectable() class F {}')
    await Bun.write(join(dir, 'f.skip.ts'), '@Injectable() class G {}')

    const result = await scan({ root: dir, include: ['*.ts'], exclude: ['*.skip.ts'] })
    expect(result).toHaveLength(1)
    expect(result[0]).toEndWith('f.ts')
  })
})
