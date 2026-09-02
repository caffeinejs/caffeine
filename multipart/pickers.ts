import type { FastifyRequest } from 'fastify'
import type { ParameterPickOptions, ParameterPicker } from '@caffeinejs/std/framework'
import {
  nodeStreamFile,
  nodeStreamFiles,
  nodeStreamParts,
  readFile,
  readFiles,
  readFormData,
  webStreamFile,
  webStreamFiles,
  webStreamParts,
} from './_parts.js'

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

/**
 * The built-in multipart parameter pickers, mirroring the HTTP `$p` catalog.
 * Import from `@caffeinejs/multipart` and pass into `@Args([...])`.
 *
 * A handler that receives only the context — every programmatic route, since the router owns that route's
 * parameters — reads the same parts through `multipart(ctx)` instead.
 */
export const $multipart: MultipartPickers = {
  webStreamParts: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:streamparts:web',
    picker: ((req: FastifyRequest) => webStreamParts(req)) as ParameterPicker<R>,
  }),

  webStreamFiles: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:streamfiles:web',
    picker: ((req: FastifyRequest) => webStreamFiles(req)) as ParameterPicker<R>,
  }),

  webStreamFile: <R = unknown>(fieldname?: string): ParameterPickOptions<R> => ({
    name: fieldname,
    type: 'multipart:streamfile:web',
    picker: ((req: FastifyRequest) => webStreamFile(req, fieldname)) as ParameterPicker<R>,
  }),

  streamParts: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:streamparts',
    picker: ((req: FastifyRequest) => nodeStreamParts(req)) as ParameterPicker<R>,
  }),

  streamFiles: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:streamfiles',
    picker: ((req: FastifyRequest) => nodeStreamFiles(req)) as ParameterPicker<R>,
  }),

  streamFile: <R = unknown>(fieldname?: string): ParameterPickOptions<R> => ({
    name: fieldname,
    type: 'multipart:streamfile',
    picker: ((req: FastifyRequest) => nodeStreamFile(req, fieldname)) as ParameterPicker<R>,
  }),

  file: <R = unknown>(fieldname?: string): ParameterPickOptions<R> => ({
    name: fieldname,
    type: 'multipart:file',
    async: true,
    picker: ((req: FastifyRequest) => readFile(req, fieldname)) as ParameterPicker<R>,
  }),

  files: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:files',
    async: true,
    picker: ((req: FastifyRequest) => readFiles(req)) as ParameterPicker<R>,
  }),

  formData: <R = unknown>(): ParameterPickOptions<R> => ({
    type: 'multipart:formdata',
    async: true,
    picker: ((req: FastifyRequest) => readFormData(req)) as ParameterPicker<R>,
  }),
}
