import { FastifyRequest } from 'fastify'

export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
  async?: boolean
}

export type ParameterPicker<R, O = unknown> = (req: R) => O | Promise<O>

export type Picker<R> = (req: R, parameters: Array<ParameterPickOptions<R>>) => ParameterPicker<R, Array<unknown>>

function fastifyRequest<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:request' }
}

function fastifyReply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:reply' }
}

function param<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'params' }
}

function query<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'query' }
}

function body<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'body' }
}

function header<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'header' }
}

function context<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'context' }
}

function method<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'method' }
}

function url<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'url' }
}

function path<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'path' }
}

function signal<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'signal' }
}

function port<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'port' }
}

function address<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'address' }
}

function webStreamParts<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamparts:web' }
}

function webStreamFiles<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamfiles:web' }
}

function webStreamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:streamfile:web' }
}

function streamParts<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamparts' }
}

function streamFiles<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamfiles' }
}

function streamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:streamfile' }
}

function file<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:file', async: true }
}

function files<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:files', async: true }
}

function formData<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:formdata', async: true }
}

function cookie<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'cookie' }
}

function signedCookie<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'cookie:signed', async: true }
}

function pick<R = unknown>(
  fn: (req: R) => unknown | Promise<unknown>,
  opts?: { async?: boolean },
): ParameterPickOptions<R> {
  return { type: 'custom', picker: fn as ParameterPicker<R>, async: opts?.async }
}

export const $p = {
  fastifyRequest,
  fastifyReply,
  param,
  query,
  body,
  header,
  context,
  method,
  url,
  path,
  signal,
  port,
  address,
  webStreamParts,
  webStreamFiles,
  webStreamFile,
  streamParts,
  streamFiles,
  streamFile,
  file,
  files,
  formData,
  cookie,
  signedCookie,
  pick,
}
