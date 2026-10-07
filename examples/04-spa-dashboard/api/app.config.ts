import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { $t } from '@caffeinejs/std/schema'

/**
 * Everything this application reads from its environment, in one schema.
 *
 * Every field has a default, so the example runs with nothing configured — which is the point of an example.
 * The session secret is a demo value and is named as such; a deployment overrides it from
 * `SPA_AUTH__SESSION_SECRET`.
 *
 * Keys are spelled the way an environment variable folds, because `EnvConfigSource` lowercases each path
 * segment: `secureCookie` comes from `SPA_AUTH__SECURE_COOKIE`.
 */
export const ConfigSchema = $t.Object({
  // Handed to `.server(...)` as the listen options, so the keys are Fastify's.
  server: $t.Object({
    host: $t.String({ default: '127.0.0.1' }),
    port: $t.Number({ default: 9010 }),
  }),
  log: $t.Object({
    level: $t.String({ default: 'info' }),
  }),
  auth: $t.Object({
    // The cookie scheme seals the session under this. It refuses anything shorter than 32 characters.
    sessionSecret: $t.String({ default: 'spa-dashboard-dev-session-secret-32ch!!' }),
    // The demo runs on plain http, where a Secure cookie would never be sent back. Turn this on behind TLS.
    secureCookie: $t.Boolean({ default: false }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

const conf = newConfiguration(ConfigSchema)
  .source(new EnvConfigSource({ prefix: 'SPA_' }))
  .build()

/**
 * The configuration the application resolves at `bootstrap()`. Data only: importing this module reads no
 * environment, the source reads it when the application loads.
 */
export const configuration = conf.config

/** The key the configuration the application started with is bound under, typed from the schema. */
export const kConfig = conf.configToken

/** The session cookie's name. Fixed here so the tests can read it off `Set-Cookie`. */
export const SESSION_COOKIE = 'spa.session'
