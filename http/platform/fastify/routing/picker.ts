import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import type { FastifyRequest } from 'fastify'

export interface FSTPickers {
  request<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
  reply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
}

function request<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:request' }
}

function reply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:reply' }
}

/** Picks what Fastify itself is serving into a handler argument: the request, or the reply. */
export const $fst: FSTPickers = {
  request,
  reply,
}
