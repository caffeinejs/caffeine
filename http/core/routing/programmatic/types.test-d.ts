import { $t } from '@caffeinejs/application/schema'
import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import { Router } from '../../../index.js'
import type { JoinGroupPath, JoinPath, RoutesOf } from './types.js'

/**
 * A route's descriptor is what a typed client sends and receives, so a codec is the text on the wire there, while
 * the handler works with the value it decodes to. Nothing at run time checks either, so `npm run test:typecheck` is
 * the test.
 */

const jobs = new Router('/jobs')
  .post('/')
  .schema({
    querystring: $t.Object({ timeout: $t.Duration(), tags: $t.Optional($t.List($t.String())) }),
    body: z.object({ name: z.string().transform(name => name.length) }),
    response: { 200: $t.Object({ ttl: $t.Duration() }) },
  })
  .handler(ctx => {
    expectTypeOf(ctx.req.query()).toEqualTypeOf<{ timeout: number; tags?: string[] }>()
    expectTypeOf(ctx.req.body()).toEqualTypeOf<{ name: number }>()
    return { ttl: ctx.req.query().timeout }
  })

type Job = RoutesOf<typeof jobs>

expectTypeOf<Job['query']>().toEqualTypeOf<{ timeout: string; tags?: string | string[] }>()
expectTypeOf<Job['body']>().toEqualTypeOf<{ name: string }>()
expectTypeOf<Job['output']>().toEqualTypeOf<{ ttl: string }>()
expectTypeOf<Job['responses']>().toEqualTypeOf<{ 200: { ttl: string } }>()

// The type-level joins follow the server's: a group path is rooted without a trailing "/", a route path keeps its own,
// and a route at "/" is the group's own path.
expectTypeOf<JoinPath<'', '/'>>().toEqualTypeOf<'/'>()
expectTypeOf<JoinPath<'/r/', '/x'>>().toEqualTypeOf<'/r/x'>()
expectTypeOf<JoinPath<'r', 'x/'>>().toEqualTypeOf<'/r/x/'>()
expectTypeOf<JoinPath<'/r', '/'>>().toEqualTypeOf<'/r'>()
expectTypeOf<JoinGroupPath<'', '/'>>().toEqualTypeOf<''>()
expectTypeOf<JoinGroupPath<'/a/', 'b/'>>().toEqualTypeOf<'/a/b'>()
expectTypeOf<JoinPath<'/r', '/' | '/x'>>().toEqualTypeOf<'/r' | '/r/x'>()

// A path built at run time is no literal: its parameters stay the open record.
new Router().get('/x' as string, ctx => {
  expectTypeOf(ctx.req.param()).toEqualTypeOf<Record<string, string>>()
  return null
})

// A group path that is a union joins per member: the root route of each is that group's own path.
expectTypeOf<JoinPath<'' | '/admin', '/'>>().toEqualTypeOf<'/' | '/admin'>()
expectTypeOf<JoinGroupPath<'', string>>().toEqualTypeOf<string>()

// A group path built at run time is no literal either: the routes under it keep the open parameter record.
new Router().group('/x' as string, r =>
  r.get('/items', ctx => {
    expectTypeOf(ctx.req.param()).toEqualTypeOf<Record<string, string>>()
    return null
  }),
)
