/// <reference types="@fastify/multipart" />

import { Readable } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import type { ParameterPickOptions, ParameterPicker } from '@caffeinejs/std/framework'
import type { MultipartField, MultipartFileNode, WebMultipartFile } from './multipart.js'

export interface MultipartPickers {
  file<R = unknown>(fieldname?: string): ParameterPickOptions<R>
  files<R = unknown>(): ParameterPickOptions<R>
  formData<R = unknown>(): ParameterPickOptions<R>
  streamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R>
  streamFiles<R = unknown>(): ParameterPickOptions<R>
  streamParts<R = unknown>(): ParameterPickOptions<R>
  webStreamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R>
  webStreamFiles<R = unknown>(): ParameterPickOptions<R>
  webStreamParts<R = unknown>(): ParameterPickOptions<R>
}

function webStreamParts<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:streamparts:web',
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

function webStreamFiles<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:streamfiles:web',
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

function webStreamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return {
    name: fieldname,
    type: 'multipart:streamfile:web',
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

function streamParts<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:streamparts',
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

function streamFiles<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:streamfiles',
    picker: ((req: FastifyRequest) => {
      async function* gen() {
        for await (const f of req.files()) {
          yield { type: 'file' as const, fieldname: f.fieldname, filename: f.filename, mimetype: f.mimetype, stream: f.file } satisfies MultipartFileNode
        }
      }
      return Readable.from(gen(), { objectMode: true })
    }) as ParameterPicker<R>,
  }
}

function streamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return {
    name: fieldname,
    type: 'multipart:streamfile',
    picker: ((req: FastifyRequest) => {
      async function* gen() {
        for await (const f of req.files()) {
          if (!fieldname || f.fieldname === fieldname) {
            yield { type: 'file' as const, fieldname: f.fieldname, filename: f.filename, mimetype: f.mimetype, stream: f.file } satisfies MultipartFileNode
            return
          }
          for await (const _ of f.file) { /* drain */ }
        }
      }
      return Readable.from(gen(), { objectMode: true })
    }) as ParameterPicker<R>,
  }
}

function file<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return {
    name: fieldname,
    type: 'multipart:file',
    async: true,
    picker: ((req: FastifyRequest) => {
      return (async () => {
        for await (const f of req.files()) {
          if (!fieldname || f.fieldname === fieldname) {
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
    }) as ParameterPicker<R>,
  }
}

function files<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:files',
    async: true,
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

function formData<R = unknown>(): ParameterPickOptions<R> {
  return {
    type: 'multipart:formdata',
    async: true,
    picker: ((req: FastifyRequest) => {
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
    }) as ParameterPicker<R>,
  }
}

/**
 * The built-in multipart parameter pickers, mirroring the HTTP `$p` catalog.
 * Import from `@caffeinejs/multipart` and pass into `@Args([...])`.
 */
export const $multipart: MultipartPickers = {
  webStreamParts,
  webStreamFiles,
  webStreamFile,
  streamParts,
  streamFiles,
  streamFile,
  file,
  files,
  formData,
}
