export * from './app_config.js'
export * from './application.js'
export * from './application_builder.js'
export * from './contributions.js'
export * from './decorators/index.js'
export * from './duration/index.js'
export * from './health/index.js'
export * from './hooks.js'
export * from './plugin.js'
// The schema dialect is first-class DX, so `$t` and its inference helper live on the root barrel. The rest of the
// surface (validateSchema, toJSONSchema, the guards) is framework plumbing — import it from '@caffeinejs/std/schema'.
export type { AnySchema, InferSchema } from './schema/schema.js'
export { $t } from './schema/t.js'
export { kFeatureSetup } from './lifecycle.js'
export type * from './lifecycle.js'
// framework/* is intentionally NOT re-exported here — import it via the '@caffeinejs/std/framework' subpath.
