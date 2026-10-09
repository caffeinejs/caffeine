import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { RetryInterceptor } from '../builtin/retry/index.js'
import { newClient } from '../client_builder.js'
import { API } from '../decorators/api.js'
import { ContentType } from '../decorators/content_type.js'
import { Multipart } from '../decorators/multipart.js'
import { Params } from '../decorators/params.js'
import { Body } from '../decorators/params/body.js'
import { Header } from '../decorators/params/header.js'
import { Part } from '../decorators/params/part.js'
import { UseRequestBodyConverter } from '../decorators/request_body_converter.js'
import { Retry } from '../decorators/retry.js'
import { POST, PUT } from '../decorators/verbs.js'
import { ErrFetchyInvalidMultipartBody } from '../errors.js'
import { noop } from '../noop.js'
import type { FetchyRequest } from '../request.js'
import {
  JSONRequestBodyConverter,
  MultipartRequestBodyConverter,
  type RequestBodyConverter,
} from '../request_body_converter.js'
import { fakeJSONResponse, TestTransportFactory } from './test_transport_factory.js'

/**
 * A multipart body is only as good as what a server parses back out of it, so these tests read each request the way
 * `FetchTransport` sends it: as the `Request` handed to `fetch`, parsed with `formData()`. `fetch` writes the boundary
 * into `content-type` only when nothing else set one, so a request fetchy labelled has already lost it.
 */

// What `FetchTransport` hands `fetch`.
function wire(request: FetchyRequest): Request {
  return new Request(request.url, { method: request.method, headers: request.headers.record, body: request.body })
}

// Builds a client of `TargetAPI` whose transport answers `responses` calls.
function clientOf<T extends object>(TargetAPI: new () => T, responses = 1) {
  const transportFactory = new TestTransportFactory()
  const api = newClient().baseURL('http://example.test').transportFactory(transportFactory).build().create(TargetAPI)
  const transport = transportFactory.transports[0]

  for (let i = 0; i < responses; i++) {
    transport.willRespond(fakeJSONResponse(200, {}))
  }

  return { api, transport }
}

const MarkedConverter: RequestBodyConverter = {
  convert() {
    return 'marked'
  },
}

// Encodes a title as multipart itself, under the fixed boundary its operation declares.
const PreEncodedConverter: RequestBodyConverter = {
  convert(title) {
    return new TextEncoder().encode(
      `--fixed\r\nContent-Disposition: form-data; name="title"\r\n\r\n${String(title)}\r\n--fixed--\r\n`,
    )
  },
}

@API('/documents')
class DocumentsAPI {
  @POST('/')
  @Multipart()
  @Params([Part('title'), Part('pages'), Part('file'), Part('attachment'), Part('tags')])
  upload(_title: string, _pages: number, _file: File, _attachment: Blob, _tags: string[]): Promise<unknown> {
    return noop()
  }

  @POST('/drafts')
  @Multipart()
  @Params([Part('title'), Part('note'), Part('tags')])
  draft(_title: string, _note: string | null | undefined, _tags: (string | null | undefined)[]): Promise<unknown> {
    return noop()
  }

  @POST('/annotations')
  @Multipart()
  @Params([Part('meta')])
  annotate(_meta: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/forms')
  @Multipart()
  @Params([Body()])
  submit(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/declared')
  @Multipart()
  @ContentType('multipart/form-data')
  @Params([Part('title')])
  declared(_title: string): Promise<unknown> {
    return noop()
  }

  // Listed above @Multipart(), the explicit converter is applied last and wins.
  @POST('/marked')
  @UseRequestBodyConverter(MarkedConverter)
  @Multipart()
  @ContentType('text/markdown')
  @Params([Body()])
  marked(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/encoded')
  @UseRequestBodyConverter(PreEncodedConverter)
  @Multipart()
  @ContentType('multipart/form-data; boundary=fixed')
  @Params([Body()])
  encoded(_title: string): Promise<unknown> {
    return noop()
  }

  // No @Multipart(): the JSON converter passes a FormData through.
  @POST('/typed')
  @Params([Body(), Header('Content-Type')])
  typed(_body: unknown, _contentType: string): Promise<unknown> {
    return noop()
  }
}

@API('/documents')
@ContentType('application/json')
class JSONByDefaultAPI {
  @POST('/')
  @Multipart()
  @Params([Part('title')])
  upload(_title: string): Promise<unknown> {
    return noop()
  }

  @POST('/forms')
  @Params([Body()])
  submit(_body: unknown): Promise<unknown> {
    return noop()
  }

  @POST('/converted')
  @UseRequestBodyConverter(MultipartRequestBodyConverter)
  @Params([Body()])
  convert(_body: unknown): Promise<unknown> {
    return noop()
  }
}

@API('/documents')
@Multipart()
class MultipartAPI {
  @POST('/')
  @Params([Part('title')])
  upload(_title: string): Promise<unknown> {
    return noop()
  }

  @POST('/metadata')
  @UseRequestBodyConverter(JSONRequestBodyConverter)
  @ContentType('application/vnd.acme+json')
  @Params([Body()])
  metadata(_body: unknown): Promise<unknown> {
    return noop()
  }
}

class ReportsAPI extends MultipartAPI {
  @POST('/reports')
  @Params([Part('title')])
  report(_title: string): Promise<unknown> {
    return noop()
  }
}

@API('/documents')
class FieldDeclaredAPI {
  @POST('/')
  @Multipart()
  @Params([Part('title')])
  upload!: (title: string) => Promise<unknown>
}

@API('/documents')
class RetriedAPI {
  @PUT('/')
  @Retry({ delay: 1 })
  @Multipart()
  @Params([Part('title'), Part('file')])
  replace(_title: string, _file: File): Promise<unknown> {
    return noop()
  }
}

describe('@Multipart() with Part() arguments', () => {
  it('sends them as one body a server parses back into the same parts', async () => {
    const { api, transport } = clientOf(DocumentsAPI)
    const file = new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })

    await api.upload('Q3 report', 12, file, new Blob(['raw']), ['finance', 'q3'])

    const request = transport.lastRequest!
    const sent = wire(request)
    const parts = await sent.formData()
    const sentFile = parts.get('file') as File
    const attachment = parts.get('attachment') as File

    expect(request.headers.has('content-type')).toBe(false)
    expect(sent.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(parts.get('title')).toBe('Q3 report')
    expect(parts.get('pages')).toBe('12')
    expect(sentFile.name).toBe('report.pdf')
    expect(sentFile.type).toBe('application/pdf')
    expect(await sentFile.text()).toBe('%PDF-1.7')
    // FormData names a bare Blob `blob`, and the encoder labels one without a type as bytes.
    expect(attachment.name).toBe('blob')
    expect(attachment.type).toBe('application/octet-stream')
    expect(parts.getAll('tags')).toEqual(['finance', 'q3'])
  })

  // An unset optional must not reach the server as the text "undefined" or "null".
  it('leaves out undefined and null, alone or in an array', async () => {
    const { api, transport } = clientOf(DocumentsAPI)

    await api.draft('Q3 report', null, ['finance', null, undefined])

    const parts = await wire(transport.lastRequest!).formData()

    expect([...parts.keys()]).toEqual(['title', 'tags'])
    expect(parts.getAll('tags')).toEqual(['finance'])
  })

  // FormData would send an object as "[object Object]" and bytes as "1,2", which a server stores without complaint.
  it.each([
    ['an object', { pages: 12 }, 'Object'],
    ['a nested array', [['finance']], 'Array'],
    ['bytes', new Uint8Array([1, 2]), 'Uint8Array'],
    ['a date', new Date(0), 'Date'],
    ['an object with no prototype', Object.assign(Object.create(null) as object, { pages: 12 }), 'Object'],
    // Passed where a value belongs, a callback would go out as its own source code.
    ['a function', () => 'Q3 report', 'function'],
  ])('rejects %s and sends nothing', async (_kind, value, type) => {
    const { api, transport } = clientOf(DocumentsAPI)

    const call = api.annotate(value)

    await expect(call).rejects.toBeInstanceOf(ErrFetchyInvalidMultipartBody)
    await expect(call).rejects.toThrow(
      `Cannot add part "meta" to the multipart body: expected a string, number, boolean, bigint, Blob or File, got ${type}`,
    )
    expect(transport.sendCount).toBe(0)
  })

  // The refusal is right for each of these, but only a fix that fits the value tells the caller what to write instead.
  it.each([
    ['bytes', new Uint8Array([1, 2]), 'Send bytes as new Blob([bytes])'],
    ['a Buffer', Buffer.from('%PDF'), 'Send bytes as new Blob([bytes])'],
    ['a date', new Date(0), 'Send a date as text: date.toISOString()'],
    ['a stream', Readable.from(['%PDF']), 'await fs.openAsBlob(path)'],
    ['a list of files that is not an array', new Set([new File(['a'], 'a.txt')]), 'Array.from(value)'],
    ['a nested array', [['finance']], 'value.flat()'],
    ['an object', { pages: 12 }, 'new Blob([JSON.stringify(value)]'],
  ])('names the fix that fits %s', async (_kind, value, solution) => {
    const { api } = clientOf(DocumentsAPI)

    await expect(api.annotate(value)).rejects.toThrow(solution)
  })
})

describe('a @Body() under @Multipart()', () => {
  it('sends a FormData as it is', async () => {
    const { api, transport } = clientOf(DocumentsAPI)
    const form = new FormData()
    form.append('title', 'Q3 report')

    await api.submit(form)

    expect(transport.lastRequest!.body).toBe(form)
    expect(transport.lastRequest!.headers.has('content-type')).toBe(false)
  })

  it('turns a plain object into one part per property, as Part() would', async () => {
    const { api, transport } = clientOf(DocumentsAPI)
    const file = new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })

    await api.submit({ title: 'Q3 report', pages: 12, file, tags: ['finance', 'q3'], note: undefined })

    const parts = await wire(transport.lastRequest!).formData()

    expect([...parts.keys()]).toEqual(['title', 'pages', 'file', 'tags', 'tags'])
    expect(parts.get('pages')).toBe('12')
    expect((parts.get('file') as File).name).toBe('report.pdf')
    expect(parts.getAll('tags')).toEqual(['finance', 'q3'])
  })

  // Only a FormData or the properties of a plain object are parts. Read with `Object.entries`, a string falls apart into
  // characters and an array into indexes, a Blob, a URLSearchParams or a Map gives nothing, and a class instance only its
  // own fields.
  it.each([
    ['a string', 'title=Q3', 'string'],
    ['a Blob', new Blob(['title']), 'Blob'],
    ['a URLSearchParams', new URLSearchParams({ title: 'Q3' }), 'URLSearchParams'],
    ['an array', [['title', 'Q3']], 'Array'],
    ['a Map', new Map([['title', 'Q3']]), 'Map'],
    [
      'a class instance',
      new (class Upload {
        title = 'Q3'
      })(),
      'Upload',
    ],
  ])('rejects %s and sends nothing', async (_kind, value, type) => {
    const { api, transport } = clientOf(DocumentsAPI)

    const call = api.submit(value)

    await expect(call).rejects.toBeInstanceOf(ErrFetchyInvalidMultipartBody)
    await expect(call).rejects.toThrow(
      `Cannot convert the @Body() value to multipart/form-data: expected a FormData or a plain object, got ${type}`,
    )
    expect(transport.sendCount).toBe(0)
  })
})

// A multipart body is parsed by the boundary its content-type names, and only the transport knows it. A content-type
// set anywhere before names none, so a server would find no part at all.
describe('the content-type of a FormData body', () => {
  it('drops one the class declares', async () => {
    const { api, transport } = clientOf(JSONByDefaultAPI)

    await api.upload('Q3 report')

    const request = transport.lastRequest!

    expect(request.headers.has('content-type')).toBe(false)
    expect(wire(request).headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('drops one the method declares, even multipart/form-data itself', async () => {
    const { api, transport } = clientOf(DocumentsAPI)

    await api.declared('Q3 report')

    expect((await wire(transport.lastRequest!).formData()).get('title')).toBe('Q3 report')
  })

  // Without @Multipart(), the JSON converter passes a FormData through, and a class that declares JSON for every
  // operation must not label it.
  it('drops the JSON a class declares over a FormData @Body()', async () => {
    const { api, transport } = clientOf(JSONByDefaultAPI)
    const form = new FormData()
    form.append('title', 'Q3 report')

    await api.submit(form)

    const sent = wire(transport.lastRequest!)

    expect(sent.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect((await sent.formData()).get('title')).toBe('Q3 report')
  })

  it('drops a content-type argument given with a FormData', async () => {
    const { api, transport } = clientOf(DocumentsAPI)
    const form = new FormData()
    form.append('title', 'Q3 report')

    await api.typed(form, 'application/json')

    expect(transport.lastRequest!.headers.has('content-type')).toBe(false)
    expect((await wire(transport.lastRequest!).formData()).get('title')).toBe('Q3 report')
  })

  it('drops one declared over MultipartRequestBodyConverter used without @Multipart()', async () => {
    const { api, transport } = clientOf(JSONByDefaultAPI)

    await api.convert({ title: 'Q3 report' })

    expect(transport.lastRequest!.headers.has('content-type')).toBe(false)
    expect((await wire(transport.lastRequest!).formData()).get('title')).toBe('Q3 report')
  })
})

// The rule follows the body, not the decorator: where a converter makes something other than a FormData, the type
// declared for it is the one the server needs.
describe('the content-type of a body a converter makes under @Multipart()', () => {
  it('keeps the type declared with a converter listed above @Multipart()', async () => {
    const { api, transport } = clientOf(DocumentsAPI)

    await api.marked({ title: 'Q3 report' })

    expect(transport.lastRequest!.body).toBe('marked')
    expect(transport.lastRequest!.headers.get('content-type')).toBe('text/markdown')
  })

  it('keeps the boundary declared for bytes a converter encoded itself', async () => {
    const { api, transport } = clientOf(DocumentsAPI)

    await api.encoded('Q3 report')

    const sent = wire(transport.lastRequest!)

    expect(sent.headers.get('content-type')).toBe('multipart/form-data; boundary=fixed')
    expect((await sent.formData()).get('title')).toBe('Q3 report')
  })

  it('keeps the vendor type of an operation that sends JSON under a class-level @Multipart()', async () => {
    const { api, transport } = clientOf(MultipartAPI)

    await api.metadata({ title: 'Q3 report' })

    expect(transport.lastRequest!.headers.get('content-type')).toBe('application/vnd.acme+json')
    expect(transport.lastRequest!.body).toBe('{"title":"Q3 report"}')
  })
})

describe('where @Multipart() applies', () => {
  // The same reach as @FormURLEncoded(): from any level of the class chain, to every operation the chain serves.
  it('covers every operation of a class that carries it, and of its subclasses', async () => {
    const { api, transport } = clientOf(ReportsAPI, 2)

    await api.upload('Q3 report')
    expect(transport.lastRequest!.body).toBeInstanceOf(FormData)

    await api.report('Q3 report')
    expect(transport.lastRequest!.body).toBeInstanceOf(FormData)
  })

  it('applies to an operation declared as a field', async () => {
    const { api, transport } = clientOf(FieldDeclaredAPI)

    await api.upload('Q3 report')

    expect((await wire(transport.lastRequest!).formData()).get('title')).toBe('Q3 report')
  })
})

// A FormData holds its parts rather than streaming them, so every attempt sends them whole, and an upload retries like
// any idempotent request.
describe('a retried multipart upload', () => {
  it('resends the same parts', async () => {
    const transportFactory = new TestTransportFactory()
    const api = newClient()
      .baseURL('http://example.test')
      .transportFactory(transportFactory)
      .addInterceptor(RetryInterceptor.INSTANCE)
      .build()
      .create(RetriedAPI)
    const transport = transportFactory.transports[0]
    transport
      .willFail(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }))
      .willRespond(fakeJSONResponse(200, {}))

    await api.replace('Q3 report', new File(['%PDF-1.7'], 'report.pdf'))

    const parts = await wire(transport.lastRequest!).formData()

    expect(transport.sendCount).toBe(2)
    expect(parts.get('title')).toBe('Q3 report')
    expect(await (parts.get('file') as File).text()).toBe('%PDF-1.7')
  })
})
