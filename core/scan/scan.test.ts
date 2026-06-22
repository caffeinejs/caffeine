import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globby } from 'globby'
import { describe, expect, it } from 'vitest'
import { DiCaf } from '../container.js'
import { AppRepository } from './_testdata/app/nested/repo.js'
import { AppService } from './_testdata/app/service.js'
import { JsxTsxService } from './_testdata/jsx-tsx/service.js'
import { ShallowRootService } from './_testdata/shallow/root.js'
import { scan } from './index.js'

const dir = fileURLToPath(new URL('.', import.meta.url))

describe('scan()', function () {
  it('loads decorated modules so new DiCaf() can resolve them', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
    })

    expect(loaded.length)
      .toBeGreaterThanOrEqual(4)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('helper.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('repo.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('ignored.spec.ts')))
      .toBe(false)

    const di = new DiCaf()
    await di.init()

    const service = di.get(AppService)
    expect(service)
      .toBeInstanceOf(AppService)
    expect(service.message)
      .toBe('autoload-app')
    expect(di.get(AppRepository))
      .toBeInstanceOf(AppRepository)
  })

  it('restricts loading with matchFilter', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      matchFilter: '/nested/',
    })

    expect(loaded)
      .toHaveLength(1)
    expect(loaded[0]!.endsWith('repo.ts'))
      .toBe(true)
  })

  it('restricts loading with a function matchFilter', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      matchFilter: p => p.includes('/nested/'),
    })

    expect(loaded)
      .toHaveLength(1)
    expect(loaded[0]!.endsWith('repo.ts'))
      .toBe(true)
  })

  it('restricts loading with an array matchFilter using OR semantics', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      matchFilter: ['/nested/', p => p.endsWith('config.ts')],
    })

    expect(loaded)
      .toHaveLength(2)
    expect(loaded.some(m => m.endsWith('repo.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
  })

  it('skips files with a function ignoreFilter', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      ignoreFilter: p => p.endsWith('.spec.ts'),
    })

    expect(loaded.some(m => m.endsWith('ignored.spec.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(true)
  })

  it('skips files with an array ignoreFilter using OR semantics', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      ignoreFilter: [/\.spec\.ts$/u, '/nested/'],
    })

    expect(loaded.some(m => m.endsWith('ignored.spec.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('repo.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(true)
  })

  it('respects maxDepth', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/shallow'),
      maxDepth: 0,
    })

    expect(loaded)
      .toHaveLength(1)
    expect(loaded[0]!.endsWith('root.ts'))
      .toBe(true)

    const di = new DiCaf()
    await di.init()

    expect(di.get(ShallowRootService))
      .toBeInstanceOf(ShallowRootService)
    expect(loaded.some(m => m.endsWith('deep.ts')))
      .toBe(false)
  })

  it('loads .tsx files', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/jsx-tsx'),
    })

    expect(loaded.some(m => m.endsWith('service.tsx')))
      .toBe(true)

    const di = new DiCaf()
    await di.init()

    expect(di.get(JsxTsxService))
      .toBeInstanceOf(JsxTsxService)
  })

  it('loads .jsx files', async function () {
    const loaded = await scan({
      dir: join(dir, '_testdata/jsx-tsx'),
    })

    expect(loaded.some(m => m.endsWith('helper.jsx')))
      .toBe(true)
  })

  it('excludes a file given as a file:// URL string', async function () {
    const serviceUrl = new URL('_testdata/app/service.ts', import.meta.url).href

    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      exclude: serviceUrl,
    })

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
  })

  it('excludes a file given as a URL object', async function () {
    const serviceUrl = new URL('_testdata/app/service.ts', import.meta.url)

    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      exclude: serviceUrl,
    })

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
  })

  it('excludes multiple files given as an array', async function () {
    const serviceUrl = new URL('_testdata/app/service.ts', import.meta.url).href
    const configUrl = new URL('_testdata/app/config.ts', import.meta.url).href

    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      exclude: [serviceUrl, configUrl],
    })

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('helper.ts')))
      .toBe(true)
  })

  it('excludes a file given as an absolute path string', async function () {
    const servicePath = fileURLToPath(new URL('_testdata/app/service.ts', import.meta.url))

    const loaded = await scan({
      dir: join(dir, '_testdata/app'),
      exclude: servicePath,
    })

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
  })
})

describe('scan() with compiled output', function () {
  it('loads only one file when both .ts and .js exist for the same module', async function () {
    const loaded = await scan({ dir: join(dir, '_testdata/compiled') })
    expect(loaded).toHaveLength(1)
  })

  it('prefers .ts over .js when both exist', async function () {
    const loaded = await scan({ dir: join(dir, '_testdata/compiled') })
    expect(loaded[0]).toMatch(/\.ts$/)
  })
})

describe('scan() with pre-resolved files', function () {
  it('loads modules from a Promise<string[]>', async function () {
    const appDir = join(dir, '_testdata/app')
    const loaded = await scan(globby(`${appDir}/**/*.ts`, { ignore: ['**/*.spec.ts', '**/*.test.ts'] }))

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('helper.ts')))
      .toBe(true)
    expect(loaded.some(m => m.endsWith('repo.ts')))
      .toBe(true)
  })

  it('loads modules from a pre-filtered string[]', async function () {
    const appDir = join(dir, '_testdata/app')
    const servicePath = fileURLToPath(new URL('_testdata/app/service.ts', import.meta.url))
    const files = await globby(`${appDir}/**/*.ts`)
    const loaded = await scan(files.filter(f => f !== servicePath))

    expect(loaded.some(m => m.endsWith('service.ts')))
      .toBe(false)
    expect(loaded.some(m => m.endsWith('config.ts')))
      .toBe(true)
  })
})
