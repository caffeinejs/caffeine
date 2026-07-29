import { FastifyRequest } from 'fastify'

export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
  async?: boolean
}

export type ParameterPicker<R, O = unknown> = (req: R) => O | Promise<O>

export type Picker<R> = (req: R, parameters: Array<ParameterPickOptions<R>>) => ParameterPicker<R, Array<unknown>>

export function fastifyRequest<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:request' }
}

export function fastifyReply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:reply' }
}

export function param<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'params' }
}

export function query<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'query' }
}

export function body<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'body' }
}

export function header<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'header' }
}

export function context<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'context' }
}

export function method<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'method' }
}

export function url<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'url' }
}

export function path<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'path' }
}

export function signal<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'signal' }
}

export function port<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'port' }
}

export function address<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'address' }
}

export function webStreamParts<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamparts:web' }
}

export function webStreamFiles<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamfiles:web' }
}

export function webStreamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:streamfile:web' }
}

export function streamParts<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamparts' }
}

export function streamFiles<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:streamfiles' }
}

export function streamFile<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:streamfile' }
}

export function file<R = unknown>(fieldname?: string): ParameterPickOptions<R> {
  return { name: fieldname, type: 'multipart:file', async: true }
}

export function files<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:files', async: true }
}

export function formData<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'multipart:formdata', async: true }
}

export function cookie<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'cookie' }
}

export function signedCookie<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'cookie:signed', async: true }
}

export function pick<R = unknown>(
  fn: (req: R) => unknown | Promise<unknown>,
  opts?: { async?: boolean },
): ParameterPickOptions<R> {
  return { type: 'custom', picker: fn as ParameterPicker<R>, async: opts?.async }
}
