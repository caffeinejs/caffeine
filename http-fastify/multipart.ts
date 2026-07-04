import type { Readable } from 'node:stream'

export interface WebMultipartFile {
  type: 'file'
  fieldname: string
  filename: string
  mimetype: string
  stream: ReadableStream<Uint8Array>
}

export interface MultipartFileNode {
  type: 'file'
  fieldname: string
  filename: string
  mimetype: string
  stream: Readable
}

export interface MultipartField {
  type: 'field'
  fieldname: string
  value: string
}
