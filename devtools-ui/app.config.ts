import { newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { $t } from '@caffeinejs/application/schema'

/**
 * Everything the UI reads from its environment, under `CAFFEINE_DEVTOOLS_`: `CAFFEINE_DEVTOOLS_TARGET__URL` is
 * `target.url`. With nothing set, it listens on `127.0.0.1:9091` and reads the devtools `DevTools()` serves by
 * default.
 */
export const ConfigSchema = $t.Object({
  server: $t.Object({
    host: $t.String({ default: '127.0.0.1' }),
    port: $t.Integer({ default: 9091, minimum: 0, maximum: 65_535 }),
  }),
  target: $t.Object({
    /** Where the devtools are served: the application's devtools server and path. */
    url: $t.String({ default: 'http://127.0.0.1:9090/devtools' }),
    /** Sent as `Authorization` with every request, for devtools behind `authorize(...)`: `Bearer <token>`. */
    authorization: $t.Optional($t.Secret($t.String({ minLength: 1 }))),
  }),
  /** Host names the UI answers besides loopback ones, such as the name a proxy in front of it forwards. */
  allowedHosts: $t.List($t.String({ minLength: 1 }), { default: [] }),
  log: $t.Object({
    level: $t.String({ default: 'info' }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

/** The environment variable naming the devtools the UI reads, for the pages that say how to change it. */
export const TARGET_URL_VARIABLE = 'CAFFEINE_DEVTOOLS_TARGET__URL'

/** The environment variable listing the host names the UI answers besides loopback ones. */
export const ALLOWED_HOSTS_VARIABLE = 'CAFFEINE_DEVTOOLS_ALLOWED_HOSTS'

/** The environment variable carrying the `Authorization` header the UI sends. */
export const TARGET_AUTHORIZATION_VARIABLE = 'CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION'

const conf = newConfiguration(ConfigSchema)
  .source(new EnvConfigSource({ prefix: 'CAFFEINE_DEVTOOLS_' }))
  .build()

/** The configuration the application resolves at `bootstrap()`. Importing this module reads no environment. */
export const configuration = conf.config

/** The key the configuration the application started with is bound under. */
export const kConfig = conf.configToken
