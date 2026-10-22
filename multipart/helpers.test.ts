import { once } from 'node:events'
import { connect as connectH2 } from 'node:http2'
import { connect } from 'node:net'

import { $t } from '@caffeinejs/application/schema'
import { $p, Args, Controller, Post, Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import type { Context } from '@caffeinejs/http/fastify'
import { KiB } from '@caffeinejs/std/bytes'
import { describe, it, expect } from 'vitest'

import { multipart, multipartPlugin, type MultipartContext, type MultipartOptions } from './index.js'
import type { MultipartField, MultipartFileNode, WebMultipartFile } from './multipart.js'

const BOUNDARY = '----TestBoundary123'

type ME = { name: string; value: string } | { name: string; filename: string; content: string; mime?: string }

function multipartApp() {
  return createWebApplication({}).with(() => multipartPlugin())
}

function multipartBody(entries: Array<ME>): Uint8Array {
  const parts: string[] = []
  for (const entry of entries) {
    if ('filename' in entry) {
      parts.push(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${entry.name}"; filename="${entry.filename}"\r\n` +
          `Content-Type: ${entry.mime ?? 'application/octet-stream'}\r\n` +
          `\r\n` +
          `${entry.content}\r\n`,
      )
    } else {
      parts.push(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${entry.name}"\r\n` +
          `\r\n` +
          `${entry.value}\r\n`,
      )
    }
  }
  return new TextEncoder().encode(parts.join('') + `--${BOUNDARY}--\r\n`)
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

/** Posts `entries` to `path` on an application serving `router`. */
async function upload(router: Router, path: string, entries: Array<ME>) {
  const app = multipartApp().mount(router)
  await app.bootstrap()

  try {
    return await app.fetch(path, { method: 'POST', headers: multipartHeaders(), body: multipartBody(entries) })
  } finally {
    await app.close()
  }
}

describe('multipart(ctx) on a programmatic route', () => {
  it('file() — buffers the first file, whatever field it was sent under', async () => {
    let received: File | undefined

    const router = new Router('/hf1')
    router.post('/upload').handler(async ctx => {
      received = await multipart(ctx).file()
      return {}
    })

    const res = await upload(router, '/hf1/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg-bytes', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(received).toBeInstanceOf(File)
    expect(received!.name).toBe('photo.jpg')
    expect(received!.type).toBe('image/jpeg')
    expect(await received!.text()).toBe('jpeg-bytes')
  })

  it('file(fieldname) — skips the files sent before the one asked for', async () => {
    let received: File | undefined

    const router = new Router('/hf2')
    router.post('/upload').handler(async ctx => {
      received = await multipart(ctx).file('document')
      return {}
    })

    const res = await upload(router, '/hf2/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
      { name: 'document', filename: 'report.pdf', content: 'pdf-bytes', mime: 'application/pdf' },
    ])

    expect(res.status).toBe(200)
    expect(received!.name).toBe('report.pdf')
    expect(await received!.text()).toBe('pdf-bytes')
  })

  it('file(fieldname) — answers undefined when the request never sent that field', async () => {
    let received: File | undefined | 'unset' = 'unset'

    const router = new Router('/hf3')
    router.post('/upload').handler(async ctx => {
      received = await multipart(ctx).file('missing')
      return {}
    })

    const res = await upload(router, '/hf3/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(received).toBeUndefined()
  })

  it('files() — buffers every file', async () => {
    let received: File[] = []

    const router = new Router('/hf4')
    router.post('/upload').handler(async ctx => {
      received = await multipart(ctx).files()
      return {}
    })

    const res = await upload(router, '/hf4/upload', [
      { name: 'a', filename: 'a.txt', content: 'aaa', mime: 'text/plain' },
      { name: 'b', filename: 'b.txt', content: 'bbb', mime: 'text/plain' },
    ])

    expect(res.status).toBe(200)
    expect(received.map(f => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(await received[1].text()).toBe('bbb')
  })

  it('formData() — collects fields and files into one FormData', async () => {
    let received: FormData | undefined

    const router = new Router('/hf5')
    router.post('/upload').handler(async ctx => {
      received = await multipart(ctx).formData()
      return {}
    })

    const res = await upload(router, '/hf5/upload', [
      { name: 'description', value: 'a photo' },
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg-bytes', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(received!.get('description')).toBe('a photo')
    expect(received!.get('avatar')).toBeInstanceOf(File)
    expect((received!.get('avatar') as File).name).toBe('photo.jpg')
  })

  it('webStreamFile(fieldname) — streams the named file with its metadata and bytes intact', async () => {
    let received: WebMultipartFile | undefined
    let bytes: Buffer | undefined

    const router = new Router('/hf6')
    router.post('/upload').handler(async ctx => {
      const [first] = await readStream(multipart(ctx).webStreamFile('document'))
      received = first
      bytes = await readFileBytes(first.stream)
      return {}
    })

    const res = await upload(router, '/hf6/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
      { name: 'document', filename: 'report.pdf', content: 'pdf-bytes', mime: 'application/pdf' },
    ])

    expect(res.status).toBe(200)
    expect(received!.type).toBe('file')
    expect(received!.fieldname).toBe('document')
    expect(received!.filename).toBe('report.pdf')
    expect(received!.mimetype).toBe('application/pdf')
    expect(bytes!.toString()).toBe('pdf-bytes')
  })

  it('webStreamFile(fieldname) — closes empty when the field is absent', async () => {
    let received: WebMultipartFile[] = []

    const router = new Router('/hf7')
    router.post('/upload').handler(async ctx => {
      received = await readStream(multipart(ctx).webStreamFile('missing'))
      return {}
    })

    const res = await upload(router, '/hf7/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(received).toHaveLength(0)
  })

  it('webStreamFiles() — streams every file', async () => {
    const received: WebMultipartFile[] = []

    const router = new Router('/hf8')
    router.post('/upload').handler(async ctx => {
      const files = multipart(ctx).webStreamFiles()
      const reader = files.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        received.push(value)
        await readFileBytes(value.stream)
      }
      return {}
    })

    const res = await upload(router, '/hf8/upload', [
      { name: 'a', filename: 'a.txt', content: 'aaa', mime: 'text/plain' },
      { name: 'b', filename: 'b.txt', content: 'bbb', mime: 'text/plain' },
    ])

    expect(res.status).toBe(200)
    expect(received.map(f => f.filename)).toEqual(['a.txt', 'b.txt'])
  })

  it('webStreamParts() — streams fields and files in the order they were sent', async () => {
    const received: Array<WebMultipartFile | MultipartField> = []

    const router = new Router('/hf9')
    router.post('/upload').handler(async ctx => {
      const parts = multipart(ctx).webStreamParts()
      const reader = parts.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        received.push(value)
        if (value.type === 'file') {
          await readFileBytes(value.stream)
        }
      }
      return {}
    })

    const res = await upload(router, '/hf9/upload', [
      { name: 'description', value: 'hello' },
      { name: 'doc', filename: 'doc.txt', content: 'bytes', mime: 'text/plain' },
    ])

    expect(res.status).toBe(200)
    expect(received).toHaveLength(2)
    expect((received[0] as MultipartField).value).toBe('hello')
    expect((received[1] as WebMultipartFile).filename).toBe('doc.txt')
  })

  it('streamFile(fieldname) — emits one Node MultipartFileNode', async () => {
    let received: MultipartFileNode | undefined

    const router = new Router('/hf10')
    router.post('/upload').handler(async ctx => {
      for await (const chunk of multipart(ctx).streamFile('document')) {
        received = chunk as MultipartFileNode
        for await (const _ of received.stream) {
          /* drain so busboy can advance */
        }
      }
      return {}
    })

    const res = await upload(router, '/hf10/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
      { name: 'document', filename: 'report.pdf', content: 'pdf', mime: 'application/pdf' },
    ])

    expect(res.status).toBe(200)
    expect(received!.fieldname).toBe('document')
    expect(received!.filename).toBe('report.pdf')
  })

  it('streamFiles() — emits every file, the caller draining each one', async () => {
    const received: MultipartFileNode[] = []

    const router = new Router('/hf11')
    router.post('/upload').handler(async ctx => {
      for await (const chunk of multipart(ctx).streamFiles()) {
        const node = chunk as MultipartFileNode
        received.push(node)
        for await (const _ of node.stream) {
          /* drain so busboy can advance */
        }
      }
      return {}
    })

    const res = await upload(router, '/hf11/upload', [
      { name: 'a', filename: 'a.txt', content: 'aaa', mime: 'text/plain' },
      { name: 'b', filename: 'b.txt', content: 'bbb', mime: 'text/plain' },
    ])

    expect(res.status).toBe(200)
    expect(received.map(f => f.filename)).toEqual(['a.txt', 'b.txt'])
  })

  it('streamParts() — emits fields and files as Node objects', async () => {
    const received: Array<MultipartFileNode | MultipartField> = []

    const router = new Router('/hf12')
    router.post('/upload').handler(async ctx => {
      for await (const chunk of multipart(ctx).streamParts()) {
        const part = chunk as MultipartFileNode | MultipartField
        received.push(part)
        if (part.type === 'file') {
          for await (const _ of part.stream) {
            /* drain so busboy can advance */
          }
        }
      }
      return {}
    })

    const res = await upload(router, '/hf12/upload', [
      { name: 'description', value: 'hello' },
      { name: 'doc', filename: 'doc.txt', content: 'bytes', mime: 'text/plain' },
    ])

    expect(res.status).toBe(200)
    expect(received[0].type).toBe('field')
    expect((received[0] as MultipartField).value).toBe('hello')
    expect((received[1] as MultipartFileNode).filename).toBe('doc.txt')
  })

  it('reads alongside the route parameters the router typed', async () => {
    let owner: string | undefined
    let received: File | undefined

    const router = new Router('/hf13')
    router.post('/:owner/upload').handler(async ctx => {
      owner = ctx.req.param('owner')
      received = await multipart(ctx).file('avatar')
      return {}
    })

    const res = await upload(router, '/hf13/ana/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(owner).toBe('ana')
    expect(received!.name).toBe('photo.jpg')
  })
})

describe('multipart(ctx) on a decorated route', () => {
  it('reads the upload from a handler that took the context', async () => {
    let received: File | undefined

    @Controller('/hfd1')
    class DecoratedUploadController {
      @Post('/upload')
      @Args([$p.context()])
      async upload(ctx: Context) {
        received = await multipart(ctx).file('avatar')
        return {}
      }
    }

    void [DecoratedUploadController]

    const app = multipartApp()
    await app.bootstrap()

    const res = await app.fetch('/hfd1/upload', {
      method: 'POST',
      headers: multipartHeaders(),
      body: multipartBody([{ name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' }]),
    })

    expect(res.status).toBe(200)
    expect(received!.name).toBe('photo.jpg')

    await app.close()
  })
})

describe('a route declaring its upload with $t.File', () => {
  it('serves the upload rather than failing validation on a body nobody parsed', async () => {
    let received: File | undefined

    const router = new Router('/hs1')
    router
      .post('/upload')
      .schema({ body: $t.Object({ avatar: $t.File() }) })
      .handler(async ctx => {
        received = await multipart(ctx).file('avatar')
        return {}
      })

    const res = await upload(router, '/hs1/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(200)
    expect(received!.name).toBe('photo.jpg')
  })

  it('still validates the slots that are parsed', async () => {
    const router = new Router('/hs2')
    router
      .post('/upload')
      .schema({ querystring: $t.Object({ owner: $t.String() }), body: $t.Object({ avatar: $t.File() }) })
      .handler(async ctx => {
        await multipart(ctx).file('avatar')
        return {}
      })

    const res = await upload(router, '/hs2/upload', [
      { name: 'avatar', filename: 'photo.jpg', content: 'jpeg', mime: 'image/jpeg' },
    ])

    expect(res.status).toBe(400)
  })
})

type Reader = (ctx: MultipartContext) => Promise<number[]>

// Each reader reading the whole upload, as a handler would, and answering the size of every file it read: a file
// cut short shows as a smaller size, rather than passing as whole.
const readers: Record<string, Reader> = {
  'file()': async ctx => {
    const file = await multipart(ctx).file()
    return file === undefined ? [] : [file.size]
  },
  'files()': async ctx => (await multipart(ctx).files()).map(file => file.size),
  'formData()': async ctx => {
    const sizes: number[] = []
    const form = await multipart(ctx).formData()
    form.forEach(value => {
      if (typeof value !== 'string') {
        sizes.push(value.size)
      }
    })
    return sizes
  },
  'streamFile()': async ctx => {
    const sizes: number[] = []
    for await (const node of multipart(ctx).streamFile()) {
      let size = 0
      for await (const chunk of (node as MultipartFileNode).stream) {
        size += (chunk as Buffer).length
      }
      sizes.push(size)
    }
    return sizes
  },
  'webStreamFile()': async ctx => {
    const sizes: number[] = []
    for (const file of await readStream(multipart(ctx).webStreamFile())) {
      sizes.push((await readFileBytes(file.stream)).length)
    }
    return sizes
  },
}

/** An application whose `POST /uploads/upload` reads the upload with `read`, under `limit` when one is given. */
function uploadApp(read: Reader, limit?: number, options?: MultipartOptions) {
  const router = new Router('/uploads')
  const route = router.post('/upload')
  if (limit !== undefined) {
    route.bodyLimit(limit)
  }
  route.handler(async ctx => ({ sizes: await read(ctx) }))

  return createWebApplication({})
    .with(() => multipartPlugin(options))
    .mount(router)
}

const listen = () => ({ listener: { host: '127.0.0.1', port: 0 } })

const file = (bytes: number) => multipartBody([{ name: 'upload', filename: 'upload.bin', content: 'x'.repeat(bytes) }])

/**
 * Writes `head` and `body` on a connection of its own and answers what the server sent before it closed it: a server
 * that went on reading the rest of the body would never close it, and the read would never end.
 */
async function exchange(app: { address?: { port: number } }, head: string, body: Uint8Array): Promise<string> {
  const socket = connect(app.address!.port, '127.0.0.1')
  const received: Buffer[] = []
  socket.on('data', (chunk: Buffer) => received.push(chunk))

  try {
    await once(socket, 'connect')
    socket.write(head)
    socket.write(body)
    await once(socket, 'end')
    return Buffer.concat(received).toString()
  } finally {
    socket.destroy()
  }
}

const requestHead = (framing: string) =>
  'POST /uploads/upload HTTP/1.1\r\nHost: localhost\r\n' +
  `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n${framing}\r\n\r\n`

/** Posts `body` to `app` in 256-byte chunks, then holds the request open until `held` settles, if given. */
function chunked(app: { address?: { origin: string } }, body: Uint8Array, held?: Promise<void>) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent < body.length) {
        controller.enqueue(body.slice(sent, sent + 256))
        sent += 256
        return
      }

      await held
      controller.close()
    },
  })

  return fetch(`${app.address!.origin}/uploads/upload`, {
    method: 'POST',
    headers: multipartHeaders(),
    body: stream,
    duplex: 'half',
  } as RequestInit)
}

describe('multipart(ctx) on a route that declares a bodyLimit', () => {
  // A route that lowers its limit to refuse large uploads must refuse them, whichever reader its handler uses.
  it.each(Object.entries(readers))(
    "%s refuses an upload over the route's limit with 413, as a JSON body over it is refused",
    async (_, read) => {
      const app = uploadApp(read, 1 * KiB)
      await app.bootstrap()

      try {
        const over = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(4096),
        })
        expect(over.status).toBe(413)
        expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

        const within = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(512),
        })
        expect(within.status).toBe(200)
        expect(await within.json()).toEqual({ sizes: [512] })
      } finally {
        await app.close()
      }
    },
  )

  // A request that declares its length is refused on that alone, before a byte of it is parsed, and its connection is
  // closed rather than read to the length declared, as Fastify does for a JSON body. This one declares more than the
  // limit, sends a whole form well under it, then waits: only the declared length can answer it.
  it('refuses an upload whose Content-Length is over the limit before reading it, and closes the connection', async () => {
    const app = uploadApp(readers['files()'], 1 * KiB).server(listen)
    await app.run()

    try {
      const response = await exchange(app, requestHead('Content-Length: 2048'), file(16))

      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
      expect(response).toMatch(/^connection: close$/im)
    } finally {
      await app.close()
    }
  })

  // The route's limit is the more specific setting, so it replaces the plugin's `fileSize` upwards too.
  it.each(Object.entries(readers))(
    "%s reads a file whole on a route whose limit is over the plugin's fileSize",
    async (_, read) => {
      const app = uploadApp(read, 16 * KiB, { limits: { fileSize: 1 * KiB } })
      await app.bootstrap()

      try {
        const res = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(4096),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sizes: [4096] })
      } finally {
        await app.close()
      }
    },
  )

  describe('a chunked upload, which declares no length to refuse up front', () => {
    it.each(Object.entries(readers))(
      "%s fails the upload as it passes the route's limit, with 413",
      async (_, read) => {
        const app = uploadApp(read, 1 * KiB).server(listen)
        await app.run()

        try {
          const over = await chunked(app, file(64 * 1024))
          expect(over.status).toBe(413)
          expect(over.headers.get('connection')).toBe('close')
          expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

          const within = await chunked(app, file(512))
          expect(within.status).toBe(200)
          expect(await within.json()).toEqual({ sizes: [512] })
        } finally {
          await app.close()
        }
      },
    )

    // A field is handed over only once it has been read to its end, so a limit checked only part by part would wait
    // for the rest of an oversized one; the client here never sends it.
    it('answers 413 once a field passes the limit, without waiting for the field to end', async () => {
      const app = uploadApp(readers['formData()'], 1 * KiB).server(listen)
      await app.run()

      let release!: () => void
      const held = new Promise<void>(resolve => (release = resolve))
      const opened = new TextEncoder().encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${'x'.repeat(4096)}`,
      )

      try {
        const res = await chunked(app, opened, held)

        expect(res.status).toBe(413)
        expect(res.headers.get('connection')).toBe('close')
        expect(await res.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })
      } finally {
        release()
        await app.close()
      }
    })

    // The parser stops at the file it was writing, but the client goes on sending: only closing the connection stops
    // the server reading, or waiting for, the rest of an upload it already refused.
    it('closes the connection of an upload it refused while the client is still sending', async () => {
      const app = uploadApp(readers['formData()'], 1 * KiB).server(listen)
      await app.run()

      const opened = new TextEncoder().encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="upload"; filename="upload.bin"\r\n\r\n` +
          'x'.repeat(4096),
      )
      const chunk = Buffer.concat([Buffer.from(`${opened.length.toString(16)}\r\n`), opened, Buffer.from('\r\n')])

      try {
        const response = await exchange(app, requestHead('Transfer-Encoding: chunked'), chunk)

        expect(response.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
        expect(response).toMatch(/^connection: close$/im)
      } finally {
        await app.close()
      }
    })

    // The limit caps the body, not each file on its own: two files under it are refused once together they are over.
    it('holds the whole upload to the limit, not each file alone', async () => {
      const app = uploadApp(readers['files()'], 1 * KiB).server(listen)
      await app.run()

      const files = (bytes: number) =>
        multipartBody([
          { name: 'a', filename: 'a.bin', content: 'x'.repeat(bytes) },
          { name: 'b', filename: 'b.bin', content: 'x'.repeat(bytes) },
        ])

      try {
        const over = await chunked(app, files(600))
        expect(over.status).toBe(413)
        expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

        const within = await chunked(app, files(300))
        expect(within.status).toBe(200)
        expect(await within.json()).toEqual({ sizes: [300, 300] })
      } finally {
        await app.close()
      }
    })

    // Each call goes on from where the last one stopped, so the limit is on the request, not on each call: a second
    // call is refused once the request has passed it, rather than given a limit of its own.
    it('holds the upload to the limit across the reader calls made on it', async () => {
      const app = uploadApp(async ctx => {
        const upload = multipart(ctx)
        const a = await upload.file('a')
        const b = await upload.file('b')
        return [a?.size ?? 0, b?.size ?? 0]
      }, 1 * KiB).server(listen)
      await app.run()

      try {
        const over = await chunked(
          app,
          multipartBody([
            { name: 'a', filename: 'a.bin', content: 'x'.repeat(600) },
            { name: 'b', filename: 'b.bin', content: 'x'.repeat(600) },
          ]),
        )
        expect(over.status).toBe(413)
        expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

        const within = await chunked(app, multipartBody([{ name: 'a', filename: 'a.bin', content: 'x'.repeat(300) }]))
        expect(within.status).toBe(200)
        expect(await within.json()).toEqual({ sizes: [300, 0] })
      } finally {
        await app.close()
      }
    })
  })
})

describe('multipart(ctx) on a route that declares no bodyLimit', () => {
  const cutAt = { limits: { fileSize: 1 * KiB } }

  // An application that raised the plugin's `fileSize` for its uploads keeps it on every route that declares no
  // limit: the server's own limit, kept low for JSON, does not reach them.
  it("leaves a route that declares no limit to the plugin's limits, not the server's", async () => {
    const router = new Router('/unlimited')
    router.post('/upload').handler(async ctx => ({ sizes: (await multipart(ctx).files()).map(f => f.size) }))

    const app = createWebApplication({})
      .server(() => ({ factory: { bodyLimit: 1 * KiB } }))
      .with(() => multipartPlugin({ limits: { fileSize: 16 * KiB } }))
      .mount(router)
    await app.bootstrap()

    try {
      const res = await app.fetch('/unlimited/upload', {
        method: 'POST',
        headers: multipartHeaders(),
        body: file(4096),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sizes: [4096] })
    } finally {
      await app.close()
    }
  })

  // busboy cuts a file at `fileSize` without failing it, so a reader that stops at the file it returns would hand it
  // over cut short, and a 200 would answer an upload that was never read whole.
  it.each(Object.entries(readers))(
    "%s refuses a file over the plugin's fileSize with 413, rather than hand it over cut short",
    async (_, read) => {
      const app = uploadApp(read, undefined, cutAt)
      await app.bootstrap()

      try {
        const over = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(4096),
        })
        expect(over.status).toBe(413)
        expect(await over.json()).toMatchObject({ code: 'FST_REQ_FILE_TOO_LARGE' })

        const within = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(512),
        })
        expect(within.status).toBe(200)
        expect(await within.json()).toEqual({ sizes: [512] })
      } finally {
        await app.close()
      }
    },
  )

  // A file over `fileSize` that arrives with its part is refused before a reader takes it, and its connection is closed
  // rather than read to the length declared: this one declares far more than it sends, then waits.
  it('closes the connection of a file refused as it arrives', async () => {
    const app = uploadApp(readers['file()'], undefined, cutAt).server(listen)
    await app.run()

    try {
      const response = await exchange(app, requestHead('Content-Length: 8000000'), file(4096))

      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
      expect(response).toMatch(/^connection: close$/im)
    } finally {
      await app.close()
    }
  })

  // Sent in chunks, the file is cut as it arrives, after the reader took it, and the rest of the body is still to come:
  // once the file has failed nothing reads it, so the connection is closed rather than left waiting.
  it.each(Object.entries(readers))(
    "%s refuses a chunked file as it passes the plugin's fileSize, and closes the connection",
    async (_, read) => {
      const app = uploadApp(read, undefined, cutAt).server(listen)
      await app.run()

      try {
        const over = await chunked(app, file(64 * 1024))
        expect(over.status).toBe(413)
        expect(over.headers.get('connection')).toBe('close')
        expect(await over.json()).toMatchObject({ code: 'FST_REQ_FILE_TOO_LARGE' })
      } finally {
        await app.close()
      }
    },
  )

  // The plugin's `throwFileSizeLimit: false` asks for the file cut short, and every reader goes on handing it over so.
  it.each(Object.entries(readers))(
    "%s hands a file over cut short when the plugin's throwFileSizeLimit is false",
    async (_, read) => {
      const app = uploadApp(read, undefined, { ...cutAt, throwFileSizeLimit: false })
      await app.bootstrap()

      try {
        const res = await app.fetch('/uploads/upload', {
          method: 'POST',
          headers: multipartHeaders(),
          body: file(4096),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ sizes: [1024] })
      } finally {
        await app.close()
      }
    },
  )
})

// HTTP/2 has no connection of the request's own to close: a refused upload must still be read to its end, or its stream
// waits on the rest for ever, and so does the server's close.
describe('a refused upload over HTTP/2', () => {
  /** Posts `body` over HTTP/2 and answers what the server sent, once the stream has closed. */
  async function post(origin: string, body: Uint8Array, headers: Record<string, string> = {}) {
    const session = connectH2(origin)

    try {
      const stream = session.request({
        ':method': 'POST',
        ':path': '/uploads/upload',
        ...multipartHeaders(),
        ...headers,
      })
      stream.end(body)

      const [head] = (await once(stream, 'response')) as [Record<string, string>]
      const received: Buffer[] = []
      stream.on('data', (chunk: Buffer) => received.push(chunk))
      await once(stream, 'close')

      return { status: Number(head[':status']), body: JSON.parse(Buffer.concat(received).toString()) as unknown }
    } finally {
      session.close()
    }
  }

  const overHTTP2 = () => ({ factory: { http2: true }, listener: { host: '127.0.0.1', port: 0 } })

  it.each([
    ["a file over the plugin's fileSize", undefined, false, 'FST_REQ_FILE_TOO_LARGE'],
    // Passed well into the file, once a reader is reading it.
    ["a body passing the route's limit in a file", 64 * KiB, false, 'FST_ERR_CTP_BODY_TOO_LARGE'],
    ["a Content-Length over the route's limit", 64 * KiB, true, 'FST_ERR_CTP_BODY_TOO_LARGE'],
  ] as const)('reads %s to its end once refused, so its stream closes', async (_, limit, declaresLength, code) => {
    const app = uploadApp(readers['file()'], limit, { limits: { fileSize: 1 * KiB } }).server(overHTTP2)
    await app.run()

    try {
      const body = file(256 * 1024)
      const res = await post(app.address!.origin, body, declaresLength ? { 'content-length': String(body.length) } : {})

      expect(res.status).toBe(413)
      expect(res.body).toMatchObject({ code })
    } finally {
      await app.close()
    }
  })
})
