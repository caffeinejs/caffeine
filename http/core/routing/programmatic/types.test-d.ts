import { $t } from '@caffeinejs/application/schema'
import { expectTypeOf } from 'vitest'
import { z } from 'zod'

import { Router } from '../../../index.js'
import type { RoutesOf } from './types.js'

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
