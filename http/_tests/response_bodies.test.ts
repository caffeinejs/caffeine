import { Blob as NodeBlob } from 'node:buffer'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  type ActionResult,
  Catch,
  Controller,
  ErrHTTP,
  type ErrorHandler,
  Get,
  type IContext,
  Produces,
  Responder,
  Router,
} from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import { firstMismatch, patterned } from './patterned.js'

const OCTET = 'application/octet-stream'
const PDF = 'application/pdf'

// Not a multiple of the pattern's word, so a body cut short or run long at either end shows.
const BYTES = patterned(0, 1000)

const pdf = () => new Blob([BYTES], { type: PDF })

interface Expected {
  status?: number
  type: string | RegExp
  offset?: number
  length?: number
}

/** That `res` carries exactly the pattern's bytes from `offset`, under `type`, and says how many there are. */
async function expectPatterned(res: Response, { status = 200, type, offset = 0, length = BYTES.length }: Expected) {
  expect(res.status).toBe(status)
  if (typeof type === 'string') {
    expect(res.headers.get('content-type')).toBe(type)
  } else {
    expect(res.headers.get('content-type')).toMatch(type)
  }
  expect(res.headers.get('content-length')).toBe(String(length))

  const body = new Uint8Array(await res.arrayBuffer())
  expect(body.length).toBe(length)
  expect(firstMismatch(body, offset)).toBe(-1)
}

describe('a handler that returns a Blob, a File or an ArrayBuffer sends the bytes it holds', () => {
  const resizable = () => {
    const buffer = new ArrayBuffer(0, { maxByteLength: BYTES.length })
    buffer.resize(BYTES.length)
    new Uint8Array(buffer).set(BYTES)
    return buffer
  }

  const routes = new Router('/bodies')
  routes.get('/blob').handler(() => pdf())
  routes.get('/file').handler(() => new File([BYTES], 'q3.pdf', { type: PDF }))
  routes.get('/array-buffer').handler(() => BYTES.slice().buffer)
  routes
    .get('/mixed')
    .handler(() => new Blob([BYTES.subarray(0, 300), new Blob([BYTES.subarray(300, 700)]), BYTES.subarray(700)]))
  routes.get('/csv').handler(
    () =>
      new Blob(['region,total\n', new TextEncoder().encode('north,12\n'), new Blob(['south,7\n'])], {
        type: 'text/csv',
      }),
  )
  // The global Blob is this same class; @types/node's global declaration of it does not type `slice` here.
  routes.get('/sliced').handler(() => new NodeBlob([patterned(0, 2000)]).slice(500, 1500))
  routes.get('/resizable').handler(() => resizable())
  routes.get('/uint8').handler(() => BYTES)
  routes.get('/data-view').handler(() => new DataView(BYTES.slice().buffer))
  routes.get('/view-of-larger').handler(() => patterned(0, 4000).subarray(1000, 2000))
  routes.get('/float64').handler(() => new Float64Array([1.5, -2, Math.PI]))

  const app = createWebApplication().mount(routes)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it('sends a Blob as its bytes, under its own type', async () => {
    await expectPatterned(await app.fetch('/bodies/blob'), { type: PDF })
  })

  it('sends a File as its bytes, under its own type, without making it a download', async () => {
    const res = await app.fetch('/bodies/file')

    // Only an `Attachment` names a download: a File returned as it is shows inline, as any other body does.
    expect(res.headers.get('content-disposition')).toBeNull()
    await expectPatterned(res, { type: PDF })
  })

  it('sends an ArrayBuffer as bytes, as Fastify sends a Uint8Array', async () => {
    await expectPatterned(await app.fetch('/bodies/array-buffer'), { type: OCTET })
  })

  it('sends a Blob assembled from bytes and other Blobs in the order its parts were given', async () => {
    await expectPatterned(await app.fetch('/bodies/mixed'), { type: OCTET })
  })

  it('sends a CSV export built from text, bytes and a Blob as one document', async () => {
    const res = await app.fetch('/bodies/csv')

    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(await res.text()).toBe('region,total\nnorth,12\nsouth,7\n')
  })

  it('sends only the slice of a larger Blob, not the Blob it was cut from', async () => {
    await expectPatterned(await app.fetch('/bodies/sliced'), { type: OCTET, offset: 500 })
  })

  it('sends a resizable ArrayBuffer at the size it has when returned', async () => {
    await expectPatterned(await app.fetch('/bodies/resizable'), { type: OCTET })
  })

  // What Fastify already sends right: these keep working once the adapter handles the types it does not.
  describe('the bytes Fastify already sends', () => {
    it('sends a Uint8Array as its bytes', async () => {
      await expectPatterned(await app.fetch('/bodies/uint8'), { type: OCTET })
    })

    it('sends a DataView as the bytes it views', async () => {
      await expectPatterned(await app.fetch('/bodies/data-view'), { type: OCTET })
    })

    it('sends a view into a larger buffer as the bytes it views, not the whole buffer', async () => {
      await expectPatterned(await app.fetch('/bodies/view-of-larger'), { type: OCTET, offset: 1000 })
    })

    it('sends a Float64Array as the bytes of its numbers', async () => {
      const res = await app.fetch('/bodies/float64')

      expect(res.headers.get('content-type')).toBe(OCTET)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        new Uint8Array(new Float64Array([1.5, -2, Math.PI]).buffer),
      )
    })
  })

  describe('on HEAD', () => {
    it.each(['blob', 'file', 'array-buffer'])(
      'answers the %s route with its type and full length, and no body',
      async path => {
        const res = await app.fetch(`/bodies/${path}`, { method: 'HEAD' })

        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe(path === 'array-buffer' ? OCTET : PDF)
        expect(res.headers.get('content-length')).toBe(String(BYTES.length))
        expect(await res.text()).toBe('')
      },
    )
  })
})

describe('the edges of a body', () => {
  const routes = new Router('/edges')
  routes.get('/empty-blob').handler(() => new Blob([]))
  routes.get('/empty-array-buffer').handler(() => new ArrayBuffer(0))
  routes.get('/typed-with-parameters').handler(() => new Blob(['a,b\n'], { type: 'text/csv;charset=utf-8' }))
  routes.get('/untyped').handler(() => new Blob([BYTES]))

  const app = createWebApplication().mount(routes)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each(['empty-blob', 'empty-array-buffer'])('sends an %s as an empty body that says it is empty', async path => {
    const res = await app.fetch(`/edges/${path}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('0')
    expect(await res.text()).toBe('')
  })

  it("keeps the parameters of a Blob's type", async () => {
    const res = await app.fetch('/edges/typed-with-parameters')

    expect(res.headers.get('content-type')).toBe('text/csv;charset=utf-8')
    expect(await res.text()).toBe('a,b\n')
  })

  it('labels a Blob that has no type as bytes, never as JSON', async () => {
    await expectPatterned(await app.fetch('/edges/untyped'), { type: OCTET })
  })
})

describe("whose Content-Type a Blob goes out under: the route's or the handler's first, then its own", () => {
  @Produces('text/csv')
  @Controller('/precedence-controller')
  class ReportsController {
    @Get('/blob')
    blob() {
      return new Blob(['a,b\n'], { type: 'text/plain' })
    }
  }

  void [ReportsController]

  const routes = new Router('/precedence')
  routes
    .get('/produces')
    .produces('text/csv')
    .handler(() => new Blob(['a,b\n'], { type: 'text/plain' }))
  routes
    .get('/produces-bytes')
    .produces(PDF)
    .handler(() => BYTES.slice().buffer)
  routes.get('/handler').handler(ctx => {
    ctx.header('content-type', 'image/png')
    return new Blob(['png'], { type: 'text/plain' })
  })
  routes
    .get('/decorated')
    .status(201)
    .header('x-route', 'yes')
    .handler(() => pdf())

  const app = createWebApplication().mount(routes)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it("sends a Blob under the route's declared type rather than its own", async () => {
    const res = await app.fetch('/precedence/produces')

    expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
    expect(await res.text()).toBe('a,b\n')
  })

  it("sends a Blob under its controller's declared type rather than its own", async () => {
    const res = await app.fetch('/precedence-controller/blob')

    expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
    expect(await res.text()).toBe('a,b\n')
  })

  it("sends an ArrayBuffer under the route's declared type", async () => {
    await expectPatterned(await app.fetch('/precedence/produces-bytes'), { type: /^application\/pdf/ })
  })

  it('sends a Blob under the type its handler set on the reply rather than its own', async () => {
    const res = await app.fetch('/precedence/handler')

    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png')
  })

  it("keeps the route's status and headers on a Blob answer", async () => {
    const res = await app.fetch('/precedence/decorated')

    expect(res.headers.get('x-route')).toBe('yes')
    await expectPatterned(res, { status: 201, type: PDF })
  })
})

describe('every place an answer is sent from sends a Blob the same way', () => {
  class BlobResult extends Responder {
    constructor(readonly blob: Blob) {
      super()
    }

    respond(): ActionResult {
      return this.blob
    }
  }

  // An answer read from storage: the Responder resolves to the Blob once the read completes.
  class StoredBlobResult extends Responder {
    respond(): ActionResult {
      return Promise.resolve(pdf())
    }
  }

  // A Responder that answers nothing at all.
  class SilentResult extends Responder {
    respond(): ActionResult {
      return undefined
    }
  }

  class ErrRouteBlob extends Error {}
  class ErrGroupBlob extends Error {}
  class ErrGlobalBlob extends Error {}

  @Catch(ErrRouteBlob)
  class RouteCatcher implements ErrorHandler<ErrRouteBlob> {
    handle(ctx: IContext): ActionResult {
      ctx.status(503)
      return pdf()
    }
  }

  @Catch(ErrGroupBlob)
  class GroupCatcher implements ErrorHandler<ErrGroupBlob> {
    handle(ctx: IContext): ActionResult {
      ctx.status(502)
      return pdf()
    }
  }

  @Catch(ErrGlobalBlob)
  class GlobalCatcher implements ErrorHandler<ErrGlobalBlob> {
    handle(ctx: IContext): ActionResult {
      ctx.status(500)
      return pdf()
    }
  }

  @Controller('/sites-controller')
  class DownloadsController {
    @Get('/sync')
    sync() {
      return pdf()
    }

    @Get('/async')
    async async() {
      return pdf()
    }
  }

  void [DownloadsController]

  // One Blob, read by every request that asks for it: each takes a stream of its own.
  const shared = pdf()

  const routes = new Router('/sites')
  routes.get('/sync').handler(() => pdf())
  routes.get('/async').handler(async () => pdf())
  routes.get('/context').handler(ctx => {
    ctx.body(pdf())
  })
  routes.get('/responder').handler(() => new BlobResult(pdf()))
  routes.get('/responder-async').handler(async () => new BlobResult(pdf()))
  routes.get('/responder-stored').handler(() => new StoredBlobResult())
  routes
    .get('/route-catch')
    .catchBy([RouteCatcher])
    .handler(() => {
      throw new ErrRouteBlob()
    })
  routes.get('/global-catch').handler(() => {
    throw new ErrGlobalBlob()
  })
  routes.get('/err-http').handler(() => {
    throw new ErrHTTP(409, 'Conflict', { body: pdf() })
  })
  routes.get('/gated').handler(() => 'never reached: the middleware answers')
  routes.get('/shared').handler(() => shared)
  // Timed, so a request that is never answered fails as Fastify's 503 rather than as a hung test.
  routes
    .get('/silent')
    .timeout(1_000)
    .handler(() => new SilentResult())

  const caught = new Router('/caught').catchBy([GroupCatcher])
  caught.get('/group').handler(() => {
    throw new ErrGroupBlob()
  })

  const app = createWebApplication()
    .errorHandling(e => e.globalHandlers(GlobalCatcher))
    .use('/sites/gated', (ctx: IContext) => {
      ctx.body(pdf())
    })
    .mount(routes, caught)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each([
    ['a synchronous handler', '/sites/sync'],
    ['an asynchronous handler', '/sites/async'],
    ['a decorated synchronous handler', '/sites-controller/sync'],
    ['a decorated asynchronous handler', '/sites-controller/async'],
    ['ctx.body(...)', '/sites/context'],
    ['a Responder', '/sites/responder'],
    ['a Responder an asynchronous handler resolves to', '/sites/responder-async'],
    ['a Responder that resolves to the Blob later', '/sites/responder-stored'],
    ['a middleware that answers before the handler runs', '/sites/gated'],
  ])('sends it from %s', async (_site, path) => {
    await expectPatterned(await app.fetch(path), { type: PDF })
  })

  it.each([
    ["a route's own @Catch handler", '/sites/route-catch', 503],
    ["a group's @Catch handler", '/caught/group', 502],
    ['a global @Catch handler', '/sites/global-catch', 500],
    ['an ErrHTTP that carries it as its body', '/sites/err-http', 409],
  ])('sends it from %s, with the status it set', async (_site, path, status) => {
    await expectPatterned(await app.fetch(path), { status, type: PDF })
  })

  it('serves one Blob to many requests at once, each in full', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.fetch('/sites/shared')))

    for (const res of responses) {
      await expectPatterned(res, { type: PDF })
    }
  })

  it('answers a Responder that answers nothing with an empty body, rather than leaving the request hanging', async () => {
    const res = await app.fetch('/sites/silent')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
