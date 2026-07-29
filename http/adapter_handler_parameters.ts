/// <reference types="@fastify/multipart" />
/// <reference types="@fastify/cookie" />
import { Readable } from 'node:stream'
import { ParameterPickOptions } from '@caffeinejs/std'
import { FastifyRequest, FastifyReply } from 'fastify'
import type { WebMultipartFile, MultipartFileNode, MultipartField } from './multipart.js'

type Picker<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>
  = (req: REQ, res: RES) => unknown

export function compileHandler<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(
  params: ParameterPickOptions<REQ>[],
  fn: (...args: unknown[]) => unknown,
): (req: REQ, res: RES) => unknown {
  // Fast-path: route method has no parameters, just call the function directly
  if (params.length === 0) {
    return () => fn()
  }

  const a = params.map(p => buildPicker<REQ, RES>(p))
  const hasAsync = params.some(p => p.async === true)

  // Arity-based compilation for up to 6 parameters.
  // 6 parameters should account for all practical use cases:
  // [signal, path params, query, header, body, context]

  if (!hasAsync) {
    switch (a.length) {
      case 1:
        return (req, res) =>
          fn(a[0](req, res))
      case 2:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res))
      case 3:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res), a[2](req, res))
      case 4:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res))
      case 5:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res))
      case 6:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res), a[5](req, res))
      default: {
        const len = a.length
        return (req, res) => {
          const out = new Array(len)
          for (let i = 0; i < len; i++) {
            out[i] = a[i](req, res)
          }
          return fn(...out)
        }
      }
    }
  }

  switch (a.length) {
    case 1:
      return (req, res) =>
        Promise.all([a[0](req, res)]).then(r => fn(r[0]))
    case 2:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res)]).then(r => fn(r[0], r[1]))
    case 3:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res)]).then(r => fn(r[0], r[1], r[2]))
    case 4:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res)])
          .then(r => fn(r[0], r[1], r[2], r[3]))
    case 5:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res)])
          .then(r => fn(r[0], r[1], r[2], r[3], r[4]))
    case 6:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res), a[5](req, res)])
          .then(r => fn(r[0], r[1], r[2], r[3], r[4], r[5]))
    default: {
      const len = a.length
      return (req, res) => {
        const out = new Array(len)
        for (let i = 0; i < len; i++) {
          out[i] = a[i](req, res)
        }
        return Promise.all(out).then(args => fn(...args))
      }
    }
  }
}

function buildPicker<
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(p: ParameterPickOptions<REQ>): Picker<REQ, RES> {
  if (p.picker) {
    return req => (p.picker as (req: REQ) => unknown)(req)
  }

  const type = p.type
  const field = p.name

  switch (type) {
    case 'body':
      return req => req.body
    case 'query':
      if (field) {
        return req => (req.query as Record<string, unknown>)[field]
      } else {
        return req => req.query
      }
    case 'params':
      if (field) {
        return req => (req.params as Record<string, unknown>)[field]
      } else {
        return req => req.params
      }
    case 'header':
      if (field) {
        return req => (req.headers as Record<string, unknown>)[field]
      } else {
        return req => req.headers
      }
    case 'context':
      return req => req.caffeineContext
    case 'method':
      return req => req.method
    case 'url':
      return req => req.url
    case 'path':
      return req => {
        const i = req.url.indexOf('?')
        return i === -1 ? req.url : req.url.slice(0, i)
      }
    case 'signal':
      return req => req.signal
    case 'port':
      return req => req.port
    case 'address':
      return req => req.socket.remoteAddress
    case 'multipart:streamparts:web':
      return req => {
        const iter = req.parts()[Symbol.asyncIterator]()

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
    case 'multipart:streamfiles:web':
      return req => {
        const iter = req.files()[Symbol.asyncIterator]()

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
    case 'multipart:streamfile:web':
      return req => {
        const fieldname = field
        const iter = req.files()[Symbol.asyncIterator]()

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
              for await (const _ of value.file) { /* drain */ }
            }
          },
        })
      }
    case 'multipart:streamparts':
      return req => {
        async function* gen() {
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              yield { type: 'file' as const, fieldname: part.fieldname, filename: part.filename, mimetype: part.mimetype, stream: part.file } satisfies MultipartFileNode
            } else {
              yield { type: 'field' as const, fieldname: part.fieldname, value: part.value as string } satisfies MultipartField
            }
          }
        }
        return Readable.from(gen(), { objectMode: true })
      }
    case 'multipart:streamfiles':
      return req => {
        async function* gen() {
          for await (const f of req.files()) {
            yield { type: 'file' as const, fieldname: f.fieldname, filename: f.filename, mimetype: f.mimetype, stream: f.file } satisfies MultipartFileNode
          }
        }
        return Readable.from(gen(), { objectMode: true })
      }
    case 'multipart:streamfile':
      return req => {
        const name = field
        async function* gen() {
          for await (const f of req.files()) {
            if (!name || f.fieldname === name) {
              yield { type: 'file' as const, fieldname: f.fieldname, filename: f.filename, mimetype: f.mimetype, stream: f.file } satisfies MultipartFileNode
              return
            }
            for await (const _ of f.file) { /* drain */ }
          }
        }
        return Readable.from(gen(), { objectMode: true })
      }
    case 'multipart:file':
      return req => {
        const name = field
        return (async () => {
          for await (const f of req.files()) {
            if (!name || f.fieldname === name) {
              const chunks: Uint8Array[] = []
              for await (const chunk of f.file) {
                chunks.push(chunk)
              }
              return new File([Buffer.concat(chunks)], f.filename, { type: f.mimetype })
            }
            for await (const _ of f.file) { /* drain */ }
          }
          return undefined
        })()
      }
    case 'multipart:files':
      return req => {
        return (async () => {
          const out: File[] = []
          for await (const f of req.files()) {
            const chunks: Uint8Array[] = []
            for await (const chunk of f.file) {
              chunks.push(chunk)
            }
            out.push(new File([Buffer.concat(chunks)], f.filename, { type: f.mimetype }))
          }
          return out
        })()
      }
    case 'multipart:formdata':
      return req => {
        return (async () => {
          const fd = new FormData()
          for await (const part of req.parts()) {
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
        })()
      }
    case 'cookie':
      if (field) {
        return req => ((req as unknown as FastifyRequest).cookies as Record<string, string | undefined>)[field]
      }
      return req => (req as unknown as FastifyRequest).cookies as Record<string, string | undefined>
    case 'cookie:signed':
      if (field) {
        return req => {
          const r = req as unknown as FastifyRequest
          const raw = (r.cookies as Record<string, string | undefined>)[field]
          if (!raw) {
            return undefined
          }
          const result = r.unsignCookie(raw)
          return result.valid && result.value !== null ? result.value : false
        }
      }
      return req => {
        const r = req as unknown as FastifyRequest
        const out: Record<string, string | false | undefined> = {}
        for (const [name, value] of Object.entries(r.cookies as Record<string, string>)) {
          const result = r.unsignCookie(value)
          out[name] = result.valid && result.value !== null ? result.value : false
        }
        return out
      }
    case 'fastify:request':
      return req => req
    case 'fastify:reply':
      return (_req, res) => res
    default:
      throw new Error(`Invalid parameter type: ${type}`)
  }
}
