import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { expectTypeOf } from 'vitest'

import { createWebApplication, type Context } from '../index.js'

/**
 * What `.basePath(...)` accepts, and what a handler reads back. Nothing at run time fails when a callback stops
 * seeing the application's configuration type, or starts accepting what is not a path, so
 * `npm run test:typecheck` is the test.
 */

const schema = $t.Object({
  app: $t.Object({ basePath: $t.String({ default: '/api' }), port: $t.Number({ default: 0 }) }, { default: {} }),
})

const kConfig = token<InferConfig<typeof schema>>(Symbol('base-path.types'))
const app = createWebApplication({ config: newConfiguration(schema, kConfig).build() })

// The callback reads the application's own configuration, typed, and may take its time.
app.basePath(({ config }) => config.app.basePath)
app.basePath(async ({ config }) => config.app.basePath)
app.basePath(() => undefined)

// @ts-expect-error — a base path is a string, not the number beside it.
app.basePath(({ config }) => config.app.port)

// @ts-expect-error — the configuration declares no such key.
app.basePath(({ config }) => config.app.missing)

// Every context carries it, whatever the adapter behind it.
declare const ctx: Context
expectTypeOf(ctx.req.basePath).toEqualTypeOf<string>()
