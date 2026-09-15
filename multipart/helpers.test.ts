import { $p, Args, Controller, Post, Router, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import type { FastifyContext } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { multipart, multipartPlugin } from './index.js'
import type { MultipartField, MultipartFileNode, WebMultipartFile } from './multipart.js'

const BOUNDARY = '----TestBoundary123'

type ME = { name: string; value: string } | { name: string; filename: string; content: string; mime?: string }

function multipartApp() {
  return createWebApplication(fastifyAdapterFactory(fastify()), {}).with(() => multipartPlugin())
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
  await app.ready()

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
      async upload(ctx: FastifyContext) {
        received = await multipart(ctx).file('avatar')
        return {}
      }
    }

    void [DecoratedUploadController]

    const app = multipartApp()
    await app.ready()

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
