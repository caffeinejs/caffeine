import { gunzipSync, gzipSync, brotliCompressSync } from 'node:zlib'

import { CaffeineIoC } from '@caffeinejs/di'
import { KiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Controller } from '../../decorators/controller.js'
import { Args, BodyAsBuffer } from '../../decorators/index.js'
import { Get, Post } from '../../decorators/verbs.js'
import type { HTTPPluginFactory } from '../../plugin.js'
import { $p } from '../routing/picker.js'
import { compression } from './compress.js'
import { decompression } from './decompression.js'
import { Brotli, Compress, Decompress, Deflate, Gzip, Zstd } from './decorators.js'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

const BODY = 'compress me, '.repeat(200)
const EVERY = { 'accept-encoding': 'zstd, br, gzip, deflate' }

async function serve(plugin: HTTPPluginFactory = compression()) {
  const built = createWebApplication({ container: new CaffeineIoC() }).with(plugin)
  app = built
  await built.bootstrap()
  return built
}

// Each controller has a path of its own: `@Controller` registers into a registry every later container snapshots.
describe('coding decorators', () => {
  it('offers gzip alone under @Gzip(), whatever else the client accepts', async () => {
    @Controller('/z-gzip')
    class Zipped {
      @Gzip()
      @Get('/')
      get(): string {
        return BODY
      }
    }
    void Zipped

    const res = await (await serve()).request('/z-gzip', { headers: EVERY })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(BODY)
  })

  @Controller('/z-brotli')
  class Brotlied {
    @Brotli()
    @Get('/')
    get(): string {
      return BODY
    }
  }

  @Controller('/z-zstd')
  class Zstded {
    @Zstd()
    @Get('/')
    get(): string {
      return BODY
    }
  }

  @Controller('/z-deflate')
  class Deflated {
    @Deflate()
    @Get('/')
    get(): string {
      return BODY
    }
  }
  void [Brotlied, Zstded, Deflated]

  it.each([
    ['/z-brotli', 'br'],
    ['/z-zstd', 'zstd'],
    ['/z-deflate', 'deflate'],
  ])('offers its own coding alone on %s', async (path, coding) => {
    const res = await (await serve()).request(path, { headers: EVERY })

    expect(res.headers.get('content-encoding')).toBe(coding)
  })

  it('sends identity under @Gzip() to a client that does not accept gzip', async () => {
    @Controller('/z-gzip-only')
    class Zipped {
      @Gzip()
      @Get('/')
      get(): string {
        return BODY
      }
    }
    void Zipped

    const res = await (await serve()).request('/z-gzip-only', { headers: { 'accept-encoding': 'br' } })

    expect(res.headers.get('content-encoding')).toBe(null)
    expect(await res.text()).toBe(BODY)
  })

  it('compresses at the level @Gzip({ level }) names', async () => {
    const text = Array.from({ length: 4 * KiB }, (_, i) => `line ${i % 97} of ${i % 13}\n`).join('')

    @Controller('/z-levels')
    class Levels {
      @Gzip({ level: 1 })
      @Get('/fast')
      fast(): string {
        return text
      }

      @Gzip({ level: 9 })
      @Get('/best')
      best(): string {
        return text
      }
    }
    void Levels

    const built = await serve()
    const fast = Buffer.from(await (await built.request('/z-levels/fast', { headers: EVERY })).arrayBuffer())
    const best = Buffer.from(await (await built.request('/z-levels/best', { headers: EVERY })).arrayBuffer())

    expect(fast).toEqual(gzipSync(text, { level: 1 }))
    expect(best).toEqual(gzipSync(text, { level: 9 }))
  })

  // On one method the two settings merge; @Gzip() with no options sets no level, so @Compress's stands.
  it('keeps the level @Compress sets beside a @Gzip() with no options on the same method', async () => {
    const text = Array.from({ length: 4 * KiB }, (_, i) => `line ${i % 97} of ${i % 13}\n`).join('')

    @Controller('/z-kept-level')
    class Kept {
      @Gzip()
      @Compress({ gzip: { level: 1 } })
      @Get('/')
      get(): string {
        return text
      }
    }
    void Kept

    const res = await (await serve()).request('/z-kept-level', { headers: EVERY })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(gzipSync(text, { level: 1 }))
  })

  // TC39 decorators apply from the one nearest the method outwards: the one written first is applied last.
  it('keeps the coding of the decorator written first, which is applied last, of two on one method', async () => {
    @Controller('/z-two')
    class Two {
      @Brotli()
      @Gzip()
      @Get('/')
      get(): string {
        return BODY
      }
    }
    void Two

    const res = await (await serve()).request('/z-two', { headers: EVERY })

    expect(res.headers.get('content-encoding')).toBe('br')
  })
})

describe('@Compress', () => {
  it("turns compression on for one method under a controller's @Compress(false)", async () => {
    @Compress(false)
    @Controller('/c-mixed')
    class Mixed {
      @Get('/off')
      off(): string {
        return BODY
      }

      @Compress(true)
      @Get('/on')
      on(): string {
        return BODY
      }
    }
    void Mixed

    const built = await serve()

    expect((await built.request('/c-mixed/off', { headers: EVERY })).headers.get('content-encoding')).toBe(null)
    expect((await built.request('/c-mixed/on', { headers: EVERY })).headers.get('content-encoding')).toBe('zstd')
  })

  it("sets every method's threshold from the controller", async () => {
    @Compress({ threshold: 0 })
    @Controller('/c-small')
    class Small {
      @Get('/')
      get(): string {
        return 'tiny'
      }
    }
    void Small

    const res = await (await serve()).request('/c-small', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe('tiny')
  })
})

describe('@Decompress', () => {
  it('refuses a coding the method does not list, the method replacing its controller', async () => {
    @Decompress('gzip')
    @Controller('/d-replace')
    class Replaced {
      @Decompress('br')
      @Post('/')
      @Args([$p.body()])
      post(body: Record<string, unknown>): Record<string, unknown> {
        return body
      }
    }
    void Replaced

    const built = await serve(decompression())
    const gzip = await built.request('/d-replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync('{"a":1}'),
    })
    const br = await built.request('/d-replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: brotliCompressSync('{"a":1}'),
    })

    expect(gzip.status).toBe(415)
    expect(gzip.headers.get('accept-encoding')).toBe('br')
    expect(br.status).toBe(200)
    expect(await br.json()).toEqual({ a: 1 })
  })

  it('hands the coded bytes as they came under @Decompress(false)', async () => {
    const coded = gzipSync('{"a":1}')

    @Controller('/d-off')
    class Off {
      @Decompress(false)
      @BodyAsBuffer()
      @Post('/')
      @Args([$p.body()])
      post(body: Buffer): { size: number } {
        return { size: body.byteLength }
      }
    }
    void Off

    const res = await (
      await serve(decompression())
    ).request('/d-off', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: coded,
    })

    expect(await res.json()).toEqual({ size: coded.byteLength })
  })
})
