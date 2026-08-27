import { FastifyRequest } from 'fastify'
import type { ParameterPickOptions, ParameterPicker } from '@caffeinejs/std/framework'

export interface HTTPPickers {
  fastifyRequest<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
  fastifyReply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
  param<R = unknown>(name?: string): ParameterPickOptions<R>
  query<R = unknown>(name?: string): ParameterPickOptions<R>
  body<R = unknown>(): ParameterPickOptions<R>
  header<R = unknown>(name?: string): ParameterPickOptions<R>
  context<R = unknown>(): ParameterPickOptions<R>
  method<R = unknown>(): ParameterPickOptions<R>
  url<R = unknown>(): ParameterPickOptions<R>
  path<R = unknown>(): ParameterPickOptions<R>
  signal<R = unknown>(): ParameterPickOptions<R>
  port<R = unknown>(): ParameterPickOptions<R>
  address<R = unknown>(): ParameterPickOptions<R>
  cookie<R = unknown>(name?: string): ParameterPickOptions<R>
  signedCookie<R = unknown>(name?: string): ParameterPickOptions<R>
  pick<R = unknown>(fn: (req: R) => unknown | Promise<unknown>, opts?: { async?: boolean },): ParameterPickOptions<R>
}

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
  cookie,
  signedCookie,
  pick,
} as HTTPPickers
