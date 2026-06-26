import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import multipartPlugin from '@fastify/multipart'
import { Controller, Post, Params, query, newHTTP, file, files, parts } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '../adapter_factory.js'
import { MultipartFile, MultipartField } from '../multipart.js'

const BOUNDARY = '----TestBoundary123'

type ME = { name: string, value: string } | { name: string, filename: string, content: string, mime?: string }

function multipartBody(
  entries: Array<ME>): Buffer {
  const parts: string[] = []
  for (const entry of entries) {
    if ('filename' in entry) {
      parts.push(
        `--${BOUNDARY}\r\n`
        + `Content-Disposition: form-data; name="${entry.name}"; filename="${entry.filename}"\r\n`
        + `Content-Type: ${entry.mime ?? 'application/octet-stream'}\r\n`
        + `\r\n`
        + `${entry.content}\r\n`,
      )
    } else {
      parts.push(
        `--${BOUNDARY}\r\n`
        + `Content-Disposition: form-data; name="${entry.name}"\r\n`
        + `\r\n`
        + `${entry.value}\r\n`,
      )
    }
  }
  return Buffer.from(parts.join('') + `--${BOUNDARY}--\r\n`)
}

function multipartHeaders() {
  return { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }
}

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const items: T[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    items.push(value)
  }
  return items
}

async function readFileBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

describe('Multipart file upload', () => {
  it('file() — emits one MultipartFile with correct metadata', async () => {
    let received: MultipartFile | undefined

    @Controller('/up1')
    class Up1Controller {
      @Post('/upload')
      @Params([file()])
      async upload(f: ReadableStream<MultipartFile>) {
        const [first] = await readStream(f)
        received = first
        return {}
      }
    }

    void [Up1Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up1/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'avatar', filename: 'photo.jpg', content: 'jpeg-bytes', mime: 'image/jpeg' }]),
    })

    expect(received).toBeDefined()
    expect(received!.fieldname).toBe('avatar')
    expect(received!.filename).toBe('photo.jpg')
    expect(received!.mimetype).toBe('image/jpeg')
    expect(received!.type).toBe('file')
    expect(received!.stream).toBeInstanceOf(ReadableStream)
  })

  it('file(fieldname) — emits only the named file', async () => {
    let received: MultipartFile | undefined

    @Controller('/up2')
    class Up2Controller {
      @Post('/upload')
      @Params([file('document')])
      async upload(f: ReadableStream<MultipartFile>) {
        const [first] = await readStream(f)
        received = first
        return {}
      }
    }

    void [Up2Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up2/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'document', filename: 'report.pdf', content: 'pdf-content', mime: 'application/pdf' }]),
    })

    expect(received!.fieldname).toBe('document')
    expect(received!.filename).toBe('report.pdf')
    expect(received!.mimetype).toBe('application/pdf')
  })

  it('file(fieldname) — stream closes without emitting when field is absent', async () => {
    let items: MultipartFile[] = []

    @Controller('/up3')
    class Up3Controller {
      @Post('/upload')
      @Params([file('missing')])
      async upload(f: ReadableStream<MultipartFile>) {
        items = await readStream(f)
        return {}
      }
    }

    void [Up3Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up3/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'other', filename: 'other.txt', content: 'data' }]),
    })

    expect(items).toHaveLength(0)
  })

  it('stream bytes match uploaded content', async () => {
    const content = 'hello from test file'
    let bytes: Buffer | undefined

    @Controller('/up4')
    class Up4Controller {
      @Post('/upload')
      @Params([file()])
      async upload(f: ReadableStream<MultipartFile>) {
        const [first] = await readStream(f)
        bytes = await readFileBytes(first.stream)
        return {}
      }
    }

    void [Up4Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up4/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'file', filename: 'data.txt', content, mime: 'text/plain' }]),
    })

    expect(bytes!.toString()).toBe(content)
  })

  it('file() combined with query() — both params resolved', async () => {
    let receivedFile: MultipartFile | undefined
    let receivedUserId: string | undefined

    @Controller('/up5')
    class Up5Controller {
      @Post('/upload')
      @Params([file('avatar'), query('userId')])
      async upload(f: ReadableStream<MultipartFile>, userId: string) {
        const [first] = await readStream(f)
        receivedFile = first
        receivedUserId = userId
        return {}
      }
    }

    void [Up5Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up5/upload?userId=user-42',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'avatar', filename: 'pic.png', content: 'png', mime: 'image/png' }]),
    })

    expect(receivedFile!.filename).toBe('pic.png')
    expect(receivedUserId).toBe('user-42')
  })

  it('files() — emits all file parts', async () => {
    let received: MultipartFile[] = []

    @Controller('/up6')
    class Up6Controller {
      @Post('/upload')
      @Params([files()])
      async upload(f: ReadableStream<MultipartFile>) {
        received = await readStream(f)
        return {}
      }
    }

    void [Up6Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up6/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'a', filename: 'a.txt', content: 'aaa' },
        { name: 'b', filename: 'b.txt', content: 'bbb' },
      ]),
    })

    expect(received).toHaveLength(2)
    expect(received[0].filename).toBe('a.txt')
    expect(received[1].filename).toBe('b.txt')
  })

  it('parts() — emits file and field parts', async () => {
    let received: Array<MultipartFile | MultipartField> = []

    @Controller('/up7')
    class Up7Controller {
      @Post('/upload')
      @Params([parts()])
      async upload(p: ReadableStream<MultipartFile | MultipartField>) {
        received = await readStream(p)
        return {}
      }
    }

    void [Up7Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = newHTTP(fastifyAdapterFactory(server))
    await app.ready()

    await app.server().inject({
      method: 'POST',
      url: '/up7/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'description', value: 'a test upload' },
        { name: 'document', filename: 'doc.txt', content: 'doc-content', mime: 'text/plain' },
      ]),
    })

    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('field')
    expect((received[0] as MultipartField).value).toBe('a test upload')
    expect(received[1].type).toBe('file')
    expect((received[1] as MultipartFile).filename).toBe('doc.txt')
  })
})
