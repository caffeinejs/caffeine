import type { ParameterPickOptions, ParameterPicker } from '@caffeinejs/std/framework'
import { FastifyRequest } from 'fastify'

export interface FSTPickers {
  request<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
  reply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R>
}

export interface HTTPPickers {
  param<R = unknown>(name?: string): ParameterPickOptions<R>
  query<R = unknown>(name?: string): ParameterPickOptions<R>
  body<R = unknown>(): ParameterPickOptions<R>
  header<R = unknown>(name?: string): ParameterPickOptions<R>
  context<R = unknown>(): ParameterPickOptions<R>
  /**
   * The authenticated principal, `ctx.user`.
   *
   * Always present: a request nothing authenticated carries the anonymous principal rather than `undefined`.
   * One claim is read off it — `p.map(p.user(), u => u.findFirst('sub')?.value)` — rather than through a
   * picker of its own, since `Principal` already exposes `findFirst`, `findAll`, `hasClaim` and `isInRole`.
   */
  user<R = unknown>(): ParameterPickOptions<R>
  method<R = unknown>(): ParameterPickOptions<R>
  url<R = unknown>(): ParameterPickOptions<R>
  path<R = unknown>(): ParameterPickOptions<R>
  signal<R = unknown>(): ParameterPickOptions<R>
  port<R = unknown>(): ParameterPickOptions<R>
  address<R = unknown>(): ParameterPickOptions<R>
  cookie<R = unknown>(name?: string): ParameterPickOptions<R>
  signedCookie<R = unknown>(name?: string): ParameterPickOptions<R>
  pick<R = unknown>(fn: (req: R) => unknown | Promise<unknown>, opts?: { async?: boolean }): ParameterPickOptions<R>
  just<R = unknown>(value: unknown): ParameterPickOptions<R>
  map<In, Out, R = unknown>(
    pick: ParameterPickOptions<R>,
    fn: (value: In) => Out | Promise<Out>,
    opts?: { async?: boolean },
  ): ParameterPickOptions<unknown>
  mapAsync<In, Out, R = unknown>(
    pick: ParameterPickOptions<R>,
    fn: (value: In) => Promise<Out>,
  ): ParameterPickOptions<unknown>
  async<R = unknown>(picker: ParameterPicker<R>): ParameterPickOptions<R>

  fst: FSTPickers
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

function user<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'user' }
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

function just<R = unknown>(value: unknown): ParameterPickOptions<R> {
  return { type: 'custom', picker: () => value }
}

function map<In, Out, R>(
  pick: ParameterPickOptions<R>,
  fn: (value: In) => Out | Promise<Out>,
  opts?: { async?: boolean },
): ParameterPickOptions<unknown> {
  const before = pick.transform
  const transform =
    before === undefined ? (value: unknown) => fn(value as In) : (value: unknown) => fn(before(value) as In)

  // The pick is carried through as it stands — `type`, `name` and any `picker` — so a built-in, which has no
  // picker to chain onto, composes exactly as a custom one does.
  return {
    ...(pick as ParameterPickOptions<unknown>),
    transform,
    async: pick.async === true || opts?.async === true ? true : pick.async,
  }
}

function mapAsync<In, Out, R>(
  pick: ParameterPickOptions<R>,
  fn: (value: In) => Promise<Out>,
): ParameterPickOptions<unknown> {
  return map(pick, fn, { async: true })
}

function async<R = unknown>(picker: ParameterPicker<R>): ParameterPickOptions<R> {
  return { type: 'custom', picker, async: true }
}

// Fastify-specific pickers.

function fastifyRequest<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:request' }
}

function fastifyReply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:reply' }
}

export const $p = {
  param,
  query,
  body,
  header,
  context,
  user,
  method,
  url,
  path,
  signal,
  port,
  address,
  cookie,
  signedCookie,
  pick,
  just,
  map,
  mapAsync,
  async,

  fst: {
    request: fastifyRequest,
    reply: fastifyReply,
  },
} as HTTPPickers
