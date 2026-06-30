import type { FastifyRequest } from 'fastify'

export interface MultipartFile {
  type: 'file'
  fieldname: string
  filename: string
  mimetype: string
  stream: ReadableStream<Uint8Array>
}

export interface MultipartField {
  type: 'field'
  fieldname: string
  value: string
}

export function assertMultipartRegistered(req: FastifyRequest): void {
  if (typeof (req as unknown as Record<string, unknown>).parts !== 'function') {
    throw new Error('Cannot read multipart: @fastify/multipart plugin is not registered on this Fastify instance')
  }
}
