import type { Readable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import multipartPlugin from '@fastify/multipart'
import { Controller, Post, Params, createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '../adapter_factory.js'
import { file, files, formData, query, streamFile, streamFiles, streamParts, webStreamFile, webStreamFiles, webStreamParts } from '../route_picker.js'
import { WebMultipartFile, MultipartFileNode, MultipartField } from '../multipart.js'

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
  it('webStreamFile() — emits one MultipartFile with correct metadata', async () => {
    let received: WebMultipartFile | undefined

    @Controller('/up1')
    class Up1Controller {
      @Post('/upload')
      @Params([webStreamFile()])
      async upload(f: ReadableStream<WebMultipartFile>) {
        const [first] = await readStream(f)
        received = first
        return {}
      }
    }

    void [Up1Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
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

  it('webStreamFile(fieldname) — emits only the named file', async () => {
    let received: WebMultipartFile | undefined

    @Controller('/up2')
    class Up2Controller {
      @Post('/upload')
      @Params([webStreamFile('document')])
      async upload(f: ReadableStream<WebMultipartFile>) {
        const [first] = await readStream(f)
        received = first
        return {}
      }
    }

    void [Up2Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/up2/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'document', filename: 'report.pdf', content: 'pdf-content', mime: 'application/pdf' }]),
    })

    expect(received!.fieldname).toBe('document')
    expect(received!.filename).toBe('report.pdf')
    expect(received!.mimetype).toBe('application/pdf')
  })

  it('webStreamFile(fieldname) — stream closes without emitting when field is absent', async () => {
    let items: WebMultipartFile[] = []

    @Controller('/up3')
    class Up3Controller {
      @Post('/upload')
      @Params([webStreamFile('missing')])
      async upload(f: ReadableStream<WebMultipartFile>) {
        items = await readStream(f)
        return {}
      }
    }

    void [Up3Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
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
      @Params([webStreamFile()])
      async upload(f: ReadableStream<WebMultipartFile>) {
        const [first] = await readStream(f)
        bytes = await readFileBytes(first.stream)
        return {}
      }
    }

    void [Up4Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/up4/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'file', filename: 'data.txt', content, mime: 'text/plain' }]),
    })

    expect(bytes!.toString()).toBe(content)
  })

  it('webStreamFile() combined with query() — both params resolved', async () => {
    let receivedFile: WebMultipartFile | undefined
    let receivedUserId: string | undefined

    @Controller('/up5')
    class Up5Controller {
      @Post('/upload')
      @Params([webStreamFile('avatar'), query('userId')])
      async upload(f: ReadableStream<WebMultipartFile>, userId: string) {
        const [first] = await readStream(f)
        receivedFile = first
        receivedUserId = userId
        return {}
      }
    }

    void [Up5Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/up5/upload?userId=user-42',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'avatar', filename: 'pic.png', content: 'png', mime: 'image/png' }]),
    })

    expect(receivedFile!.filename).toBe('pic.png')
    expect(receivedUserId).toBe('user-42')
  })

  it('webStreamFiles() — emits all file parts', async () => {
    let received: WebMultipartFile[] = []

    @Controller('/up6')
    class Up6Controller {
      @Post('/upload')
      @Params([webStreamFiles()])
      async upload(f: ReadableStream<WebMultipartFile>) {
        received = await readStream(f)
        return {}
      }
    }

    void [Up6Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
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

  it('webStreamParts() — emits file and field parts', async () => {
    let received: Array<WebMultipartFile | MultipartField> = []

    @Controller('/up7')
    class Up7Controller {
      @Post('/upload')
      @Params([webStreamParts()])
      async upload(p: ReadableStream<WebMultipartFile | MultipartField>) {
        received = await readStream(p)
        return {}
      }
    }

    void [Up7Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
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
    expect((received[1] as WebMultipartFile).filename).toBe('doc.txt')
  })

  it('file() — returns a Web API File with correct metadata and content', async () => {
    let received: File | undefined

    @Controller('/wf1')
    class Wf1Controller {
      @Post('/upload')
      @Params([file()])
      async upload(f: File | undefined) {
        received = f
        return {}
      }
    }

    void [Wf1Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/wf1/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'avatar', filename: 'photo.jpg', content: 'jpeg-bytes', mime: 'image/jpeg' }]),
    })

    expect(received).toBeInstanceOf(File)
    expect(received!.name).toBe('photo.jpg')
    expect(received!.type).toBe('image/jpeg')
    expect(Buffer.from(await received!.arrayBuffer()).toString()).toBe('jpeg-bytes')
  })

  it('file(fieldname) — returns only the named field', async () => {
    let received: File | undefined

    @Controller('/wf2')
    class Wf2Controller {
      @Post('/upload')
      @Params([file('document')])
      async upload(f: File | undefined) {
        received = f
        return {}
      }
    }

    void [Wf2Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/wf2/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'other', filename: 'other.txt', content: 'other' },
        { name: 'document', filename: 'report.pdf', content: 'pdf-content', mime: 'application/pdf' },
      ]),
    })

    expect(received).toBeInstanceOf(File)
    expect(received!.name).toBe('report.pdf')
    expect(received!.type).toBe('application/pdf')
  })

  it('file(fieldname) — returns undefined when field is absent', async () => {
    let received: File | undefined = new File([], 'placeholder')

    @Controller('/wf3')
    class Wf3Controller {
      @Post('/upload')
      @Params([file('missing')])
      async upload(f: File | undefined) {
        received = f
        return {}
      }
    }

    void [Wf3Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/wf3/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'other', filename: 'other.txt', content: 'data' }]),
    })

    expect(received).toBeUndefined()
  })

  it('files() — returns an array of Web API File instances', async () => {
    let received: File[] = []

    @Controller('/wf4')
    class Wf4Controller {
      @Post('/upload')
      @Params([files()])
      async upload(f: File[]) {
        received = f
        return {}
      }
    }

    void [Wf4Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/wf4/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'a', filename: 'a.txt', content: 'aaa', mime: 'text/plain' },
        { name: 'b', filename: 'b.txt', content: 'bbb', mime: 'text/plain' },
      ]),
    })

    expect(received).toHaveLength(2)
    expect(received[0]).toBeInstanceOf(File)
    expect(received[0].name).toBe('a.txt')
    expect(received[1].name).toBe('b.txt')
  })

  it('formData() — returns FormData with fields and files', async () => {
    let received: FormData | undefined

    @Controller('/wf5')
    class Wf5Controller {
      @Post('/upload')
      @Params([formData()])
      async upload(fd: FormData) {
        received = fd
        return {}
      }
    }

    void [Wf5Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/wf5/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'description', value: 'hello world' },
        { name: 'avatar', filename: 'pic.png', content: 'png-data', mime: 'image/png' },
      ]),
    })

    expect(received).toBeInstanceOf(FormData)
    expect(received!.get('description')).toBe('hello world')
    const avatarFile = received!.get('avatar')
    expect(avatarFile).toBeInstanceOf(File)
    expect((avatarFile as File).name).toBe('pic.png')
    expect((avatarFile as File).type).toBe('image/png')
  })

  it('streamFile() — emits one MultipartFileNode via Node.js Readable', async () => {
    let received: MultipartFileNode | undefined

    @Controller('/nf1')
    class Nf1Controller {
      @Post('/upload')
      @Params([streamFile()])
      async upload(stream: Readable) {
        for await (const chunk of stream) {
          received = chunk as MultipartFileNode
        }
        return {}
      }
    }

    void [Nf1Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/nf1/upload',
      headers: multipartHeaders(),
      payload: multipartBody([{ name: 'avatar', filename: 'photo.jpg', content: 'jpeg-bytes', mime: 'image/jpeg' }]),
    })

    expect(received).toBeDefined()
    expect(received!.type).toBe('file')
    expect(received!.fieldname).toBe('avatar')
    expect(received!.filename).toBe('photo.jpg')
    expect(received!.mimetype).toBe('image/jpeg')
  })

  it('streamFile(fieldname) — skips non-matching files', async () => {
    let received: MultipartFileNode | undefined

    @Controller('/nf2')
    class Nf2Controller {
      @Post('/upload')
      @Params([streamFile('document')])
      async upload(stream: Readable) {
        for await (const chunk of stream) {
          received = chunk as MultipartFileNode
        }
        return {}
      }
    }

    void [Nf2Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/nf2/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'other', filename: 'other.txt', content: 'skip-me' },
        { name: 'document', filename: 'report.pdf', content: 'pdf-bytes', mime: 'application/pdf' },
      ]),
    })

    expect(received!.fieldname).toBe('document')
    expect(received!.filename).toBe('report.pdf')
  })

  it('streamFiles() — emits all MultipartFileNode items', async () => {
    const received: MultipartFileNode[] = []

    @Controller('/nf3')
    class Nf3Controller {
      @Post('/upload')
      @Params([streamFiles()])
      async upload(stream: Readable) {
        for await (const chunk of stream) {
          const node = chunk as MultipartFileNode
          received.push(node)
          for await (const _ of node.stream) { /* drain so busboy can advance */ }
        }
        return {}
      }
    }

    void [Nf3Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/nf3/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'a', filename: 'a.txt', content: 'aaa', mime: 'text/plain' },
        { name: 'b', filename: 'b.txt', content: 'bbb', mime: 'text/plain' },
      ]),
    })

    expect(received).toHaveLength(2)
    expect(received[0].filename).toBe('a.txt')
    expect(received[1].filename).toBe('b.txt')
  })

  it('streamParts() — emits file and field MultipartFileNode | MultipartField items', async () => {
    const received: Array<MultipartFileNode | MultipartField> = []

    @Controller('/nf4')
    class Nf4Controller {
      @Post('/upload')
      @Params([streamParts()])
      async upload(stream: Readable) {
        for await (const chunk of stream) {
          const part = chunk as MultipartFileNode | MultipartField
          received.push(part)
          if (part.type === 'file') {
            for await (const _ of (part as MultipartFileNode).stream) { /* drain so busboy can advance */ }
          }
        }
        return {}
      }
    }

    void [Nf4Controller]

    const server = fastify()
    await server.register(multipartPlugin)
    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    await app.instance.inject({
      method: 'POST',
      url: '/nf4/upload',
      headers: multipartHeaders(),
      payload: multipartBody([
        { name: 'description', value: 'hello' },
        { name: 'doc', filename: 'doc.txt', content: 'bytes', mime: 'text/plain' },
      ]),
    })

    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('field')
    expect((received[0] as MultipartField).value).toBe('hello')
    expect(received[1].type).toBe('file')
    expect((received[1] as MultipartFileNode).filename).toBe('doc.txt')
  })
})
