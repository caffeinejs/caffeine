/// <reference types="@fastify/multipart" />

import { Readable } from 'node:stream'

import type { CaffeineRouteConfig } from '@caffeinejs/http/fastify'
import type { Multipart, MultipartFile } from '@fastify/multipart'
import { errorCodes, type FastifyRequest } from 'fastify'

import type { MultipartField, MultipartFileNode, WebMultipartFile } from './multipart.js'

// The multipart readers, over the Fastify request. Both public surfaces are thin wrappers: `pickers.ts` for a
// decorated handler's arguments, `helpers.ts` for a handler that only receives the context.

// The request's parts, held to the `bodyLimit` the route declared, on itself or on its group, as a JSON or a raw body
// is. Fastify checks a limit only on a body it reads itself, and the plugin's parser reads nothing: busboy reads the
// request later, from here. A route that declared no limit is held to the plugin's `limits` alone.
async function* partsOf(req: FastifyRequest): AsyncGenerator<Multipart> {
  const caffeine: CaffeineRouteConfig | undefined = req.routeOptions.config.$caffeine
  const limit = caffeine?.compiled?.route.bodyLimit

  if (limit === undefined) {
    yield* req.parts()
    return
  }

  if (Number(req.headers['content-length']) > limit) {
    throw tooLarge(req)
  }

  // The route's limit stands in for the plugin's `fileSize`, above it as well as below.
  const parts = req.parts({ limits: { fileSize: limit } })
  let next = parts.next()
  const count = countOf(req, limit)

  while (true) {
    let step: IteratorResult<Multipart>
    try {
      step = await Promise.race([next, count.passed])
    } catch (err) {
      // The plugin's own failure for a file cut at `fileSize` comes from the same overflow, and answers as it does.
      throw count.bytes > limit ? tooLarge(req) : err
    }

    if (count.bytes > limit) {
      throw tooLarge(req)
    }

    const { value, done } = step
    if (done) {
      return
    }

    count.reading = value.type === 'file' ? value.file : undefined
    yield value
    next = parts.next()
  }
}

// What a request held to its route's limit has sent busboy. One per request, not per reader call: each call goes on
// from where the last one stopped, and so does the count.
interface Count {
  bytes: number
  // The file busboy is writing: past the limit it fails, which is what stops busboy.
  reading: Readable | undefined
  // Settles once the limit is passed, ending a reader's wait for its next part as the end of the body would: a field
  // is handed over only once it has ended, and one past the limit may never end.
  passed: Promise<IteratorReturnResult<undefined>>
}

const counts = new WeakMap<FastifyRequest, Count>()

// The request's count, started by its first reader just after its first `next()`, which pipes the request into busboy
// before it returns, so the count starts at the first byte. It stays on once that reader is done: `file()` and its
// stream spellings hand a file over before it has been read.
function countOf(req: FastifyRequest, limit: number): Count {
  const started = counts.get(req)
  if (started !== undefined) {
    return started
  }

  let pass!: () => void
  const count: Count = {
    bytes: 0,
    reading: undefined,
    passed: new Promise(resolve => {
      pass = () => resolve({ done: true, value: undefined })
    }),
  }

  const counter = (chunk: Buffer) => {
    count.bytes += chunk.length
    if (count.bytes > limit) {
      req.raw.off('data', counter)
      count.reading?.destroy(tooLarge(req))
      pass()
    }
  }

  req.raw.on('data', counter)
  counts.set(req, count)

  return count
}

// Refuses a body over the limit as Fastify refuses one it reads itself: with the connection closed, since the client
// may still be sending the rest, and nothing will read it.
function tooLarge(req: FastifyRequest): Error {
  req.httpContext.header('connection', 'close')
  return new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE()
}

// The request's files, held as `partsOf` holds them, its fields passed over.
async function* filesOf(req: FastifyRequest): AsyncGenerator<MultipartFile> {
  for await (const part of partsOf(req)) {
    if (part.type === 'file') {
      yield part
    }
  }
}

export function webStreamParts(req: FastifyRequest): ReadableStream<WebMultipartFile | MultipartField> {
  const iter = partsOf(req)

  return new ReadableStream<WebMultipartFile | MultipartField>({
    async pull(controller) {
      const { value, done } = await iter.next()
      if (done) {
        controller.close()
        return
      }

      if (value.type === 'file') {
        controller.enqueue({
          type: 'file',
          fieldname: value.fieldname,
          filename: value.filename,
          mimetype: value.mimetype,
          stream: Readable.toWeb(value.file),
        })
      } else {
        controller.enqueue({
          type: 'field',
          fieldname: value.fieldname,
          value: value.value as string,
        })
      }
    },
  })
}

export function webStreamFiles(req: FastifyRequest): ReadableStream<WebMultipartFile> {
  const iter = filesOf(req)

  return new ReadableStream<WebMultipartFile>({
    async pull(controller) {
      const { value, done } = await iter.next()
      if (done) {
        controller.close()
        return
      }

      controller.enqueue({
        type: 'file',
        fieldname: value.fieldname,
        filename: value.filename,
        mimetype: value.mimetype,
        stream: Readable.toWeb(value.file),
      })
    },
  })
}

export function webStreamFile(req: FastifyRequest, fieldname?: string): ReadableStream<WebMultipartFile> {
  const iter = filesOf(req)

  return new ReadableStream<WebMultipartFile>({
    async pull(controller) {
      while (true) {
        const { value, done } = await iter.next()
        if (done) {
          controller.close()
          return
        }

        if (!fieldname || value.fieldname === fieldname) {
          controller.enqueue({
            type: 'file',
            fieldname: value.fieldname,
            filename: value.filename,
            mimetype: value.mimetype,
            stream: Readable.toWeb(value.file),
          })

          controller.close()

          return
        }

        // Drain the skipped file — busboy blocks until each file stream is consumed
        for await (const _ of value.file) {
          /* drain */
        }
      }
    },
  })
}

export function nodeStreamParts(req: FastifyRequest): Readable {
  async function* gen() {
    for await (const part of partsOf(req)) {
      if (part.type === 'file') {
        yield {
          type: 'file' as const,
          fieldname: part.fieldname,
          filename: part.filename,
          mimetype: part.mimetype,
          stream: part.file,
        } satisfies MultipartFileNode
      } else {
        yield {
          type: 'field' as const,
          fieldname: part.fieldname,
          value: part.value as string,
        } satisfies MultipartField
      }
    }
  }
  return Readable.from(gen(), { objectMode: true })
}

export function nodeStreamFiles(req: FastifyRequest): Readable {
  async function* gen() {
    for await (const f of filesOf(req)) {
      yield {
        type: 'file' as const,
        fieldname: f.fieldname,
        filename: f.filename,
        mimetype: f.mimetype,
        stream: f.file,
      } satisfies MultipartFileNode
    }
  }
  return Readable.from(gen(), { objectMode: true })
}

export function nodeStreamFile(req: FastifyRequest, fieldname?: string): Readable {
  async function* gen() {
    for await (const f of filesOf(req)) {
      if (!fieldname || f.fieldname === fieldname) {
        yield {
          type: 'file' as const,
          fieldname: f.fieldname,
          filename: f.filename,
          mimetype: f.mimetype,
          stream: f.file,
        } satisfies MultipartFileNode
        return
      }
      for await (const _ of f.file) {
        /* drain */
      }
    }
  }
  return Readable.from(gen(), { objectMode: true })
}

export async function readFile(req: FastifyRequest, fieldname?: string): Promise<File | undefined> {
  for await (const f of filesOf(req)) {
    if (!fieldname || f.fieldname === fieldname) {
      const chunks: Uint8Array[] = []
      for await (const chunk of f.file) {
        chunks.push(chunk)
      }
      return new File([Buffer.concat(chunks)], f.filename, { type: f.mimetype })
    }
    for await (const _ of f.file) {
      /* drain */
    }
  }
  return undefined
}

export async function readFiles(req: FastifyRequest): Promise<File[]> {
  const out: File[] = []
  for await (const f of filesOf(req)) {
    const chunks: Uint8Array[] = []
    for await (const chunk of f.file) {
      chunks.push(chunk)
    }
    out.push(new File([Buffer.concat(chunks)], f.filename, { type: f.mimetype }))
  }
  return out
}

export async function readFormData(req: FastifyRequest): Promise<FormData> {
  const fd = new FormData()
  for await (const part of partsOf(req)) {
    if (part.type === 'file') {
      const chunks: Uint8Array[] = []
      for await (const chunk of part.file) {
        chunks.push(chunk)
      }
      const webFile = new File([Buffer.concat(chunks)], part.filename, { type: part.mimetype })
      fd.append(part.fieldname, webFile, part.filename)
    } else {
      fd.append(part.fieldname, part.value as string)
    }
  }
  return fd
}
