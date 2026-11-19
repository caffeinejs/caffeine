import { afterEach, describe, expect, it, vi } from 'vitest'

import { $cond } from './conditional.js'
import { CaffeineIoC } from './container.js'
import { ErrInvalidBinding } from './errors.js'
import { token } from './key.js'

describe('runtime conditions', function () {
  const helpers = ['bun', 'deno', 'node', 'browser', 'worker'] as const

  // Binds one key per helper, compiles, and returns the helpers whose binding registered.
  async function registered(): Promise<string[]> {
    const di = new CaffeineIoC({ decorators: false })
    const keys = helpers.map(name => {
      const key = token<string>(Symbol(`cond-runtime-${name}`))
      di.bind(key, t => t.toValue(name).conditional($cond[name]()))
      return key
    })
    await di.init()

    return helpers.filter((_, i) => di.has(keys[i]))
  }

  class Scope {}

  function stubWorker(): void {
    vi.stubGlobal('WorkerGlobalScope', Scope)
    vi.stubGlobal('self', new Scope())
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('node() registers the binding on Node.js, and the other helpers skip it', async function () {
    expect(await registered()).toEqual(['node'])
  })

  it('bun() registers the binding on Bun, and node() skips it, though Bun reports a Node.js version', async function () {
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('navigator', { userAgent: 'Bun/1.4.4' })

    expect(await registered()).toEqual(['bun'])
  })

  it('deno() registers the binding on Deno, and node() skips it, though Deno reports a Node.js version', async function () {
    vi.stubGlobal('Deno', {})
    vi.stubGlobal('navigator', { userAgent: 'Deno/2.9.7' })

    expect(await registered()).toEqual(['deno'])
  })

  it('node() skips the binding on another host that reports a Node.js version, such as Cloudflare Workers', async function () {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })

    expect(await registered()).toEqual([])
  })

  it('node() registers the binding on Node.js started without navigator', async function () {
    vi.stubGlobal('navigator', undefined)

    expect(await registered()).toEqual(['node'])
  })

  it('node() skips the binding on a host with neither navigator nor a Node.js version', async function () {
    vi.stubGlobal('navigator', undefined)

    const versions = Object.getOwnPropertyDescriptor(process, 'versions')!
    Object.defineProperty(process, 'versions', { ...versions, value: {} })
    let result: string[]
    try {
      result = await registered()
    } finally {
      Object.defineProperty(process, 'versions', versions)
    }

    expect(result).toEqual([])
  })

  it('browser() registers the binding on a browser page, and node() and worker() skip it', async function () {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', {})

    expect(await registered()).toEqual(['browser'])
  })

  it('browser() registers the binding in a DOM test environment on Bun, and bun() skips it', async function () {
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', {})

    expect(await registered()).toEqual(['browser'])
  })

  it('browser() skips the binding when document is null', async function () {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', null)

    expect(await registered()).toEqual(['node'])
  })

  it('browser() skips the binding on a host with window but no document', async function () {
    vi.stubGlobal('window', {})

    expect(await registered()).toEqual(['node'])
  })

  it('worker() registers the binding in a browser worker, and browser() and node() skip it', async function () {
    stubWorker()
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })

    expect(await registered()).toEqual(['worker'])
  })

  it('deno() registers the binding in a Deno worker and worker() skips it, though it defines worker globals', async function () {
    stubWorker()
    vi.stubGlobal('Deno', {})
    vi.stubGlobal('navigator', { userAgent: 'Deno/2.9.7' })

    expect(await registered()).toEqual(['deno'])
  })

  it('worker() skips the binding on Cloudflare Workers, though it defines worker globals', async function () {
    stubWorker()
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })

    expect(await registered()).toEqual([])
  })

  it('worker() skips the binding on a host with a browser user agent but no worker scope', async function () {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })

    expect(await registered()).toEqual([])
  })

  it('worker() skips the binding on a browser page', async function () {
    stubWorker()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })

    expect(await registered()).toEqual(['browser'])
  })

  it('a hand-written runtime condition for another runtime is refused', async function () {
    const di = new CaffeineIoC({ decorators: false })
    const kOther = token<string>(Symbol('cond-runtime-other'))
    const bind = () =>
      di.bind(kOther, t => t.toValue('other').conditional({ kind: 'runtime', runtime: 'workerd' } as never))

    expect(bind).toThrow(ErrInvalidBinding)
    expect(bind).toThrow('expected a condition built with $cond')
  })
})
