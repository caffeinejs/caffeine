/// <reference types="@fastify/multipart" />

import { Readable } from 'node:stream'

import type { FastifyRequest } from 'fastify'

import type { MultipartField, MultipartFileNode, WebMultipartFile } from './multipart.js'

// The multipart readers, over the Fastify request. Both public surfaces are thin wrappers: `pickers.ts` for a
// decorated handler's arguments, `helpers.ts` for a handler that only receives the context.

export function webStreamParts(req: FastifyRequest): ReadableStream<WebMultipartFile | MultipartField> {
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

export function webStreamFiles(req: FastifyRequest): ReadableStream<WebMultipartFile> {
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

export function webStreamFile(req: FastifyRequest, fieldname?: string): ReadableStream<WebMultipartFile> {
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
        for await (const _ of value.file) {
          /* drain */
        }
      }
    },
  })
}

export function nodeStreamParts(req: FastifyRequest): Readable {
  async function* gen() {
    for await (const part of req.parts()) {
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
    for await (const f of req.files()) {
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
    for await (const f of req.files()) {
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
  for await (const f of req.files()) {
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
  for await (const f of req.files()) {
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
}
