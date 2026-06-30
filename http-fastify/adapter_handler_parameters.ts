/// <reference types="@fastify/multipart" />
/// <reference types="@fastify/cookie" />
import { Readable } from 'node:stream'
import { ParameterPickOptions } from '@caffeinejs/http'
import { FastifyRequest, FastifyReply } from 'fastify'
import { assertMultipartRegistered, MultipartFile, MultipartField } from './multipart.js'

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
      return req => req.url.split('?')[0]
    case 'signal':
      return req => req.signal
    case 'port':
      return req => req.port
    case 'address':
      return req => req.socket.remoteAddress
    case 'multipart:parts':
      return req => {
        assertMultipartRegistered(req)

        const iter = req.parts()[Symbol.asyncIterator]()

        return new ReadableStream<MultipartFile | MultipartField>({
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
    case 'multipart:files':
      return req => {
        assertMultipartRegistered(req)

        const iter = req.files()[Symbol.asyncIterator]()

        return new ReadableStream<MultipartFile>({
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
    case 'multipart:file':
      return req => {
        assertMultipartRegistered(req)

        const fieldname = field
        const iter = req.files()[Symbol.asyncIterator]()

        return new ReadableStream<MultipartFile>({
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
    default:
      throw new Error(`Invalid parameter type: ${type}`)
  }
}
