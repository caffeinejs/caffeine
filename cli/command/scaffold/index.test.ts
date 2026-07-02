import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { scaffold } from './scaffolder.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'caffeine-scaffold-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('scaffold()', () => {
  test('copies files preserving directory structure', async () => {
    const templateDir = join(tmpDir, 'tpl-copy')
    await mkdir(join(templateDir, 'src'), { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app', version: '0.0.0' }))
    await writeFile(join(templateDir, 'src', 'main.ts'), 'console.log("hello")\n')

    const outDir = join(tmpDir, 'out-copy')
    await scaffold({ templateDir, outDir, projectName: 'test-project' })

    const main = await readFile(join(outDir, 'src', 'main.ts'), 'utf-8')
    expect(main).toBe('console.log("hello")\n')
  })

  test('injects projectName into package.json', async () => {
    const templateDir = join(tmpDir, 'tpl-pkg')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app', version: '1.2.3', type: 'module' }))

    const outDir = join(tmpDir, 'out-pkg')
    await scaffold({ templateDir, outDir, projectName: 'my-real-project' })

    const pkg = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf-8')) as Record<string, unknown>
    expect(pkg.name).toBe('my-real-project')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.type).toBe('module')
  })

  test('copies non-package.json files verbatim', async () => {
    const templateDir = join(tmpDir, 'tpl-verbatim')
    await mkdir(templateDir, { recursive: true })
    const content = 'export const x = 1\n'
    await writeFile(join(templateDir, 'index.ts'), content)
    await writeFile(join(templateDir, 'package.json'), JSON.stringify({ name: 'my-app' }))

    const outDir = join(tmpDir, 'out-verbatim')
    await scaffold({ templateDir, outDir, projectName: 'proj' })

    const copied = await readFile(join(outDir, 'index.ts'), 'utf-8')
    expect(copied).toBe(content)
  })
})
