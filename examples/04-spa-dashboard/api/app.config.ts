import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { EnvConfigSource, type InferConfig } from '@caffeinejs/std/config'

/**
 * Everything this application reads from its environment, in one schema.
 *
 * Every field has a default, so the example runs with nothing configured — which is the point of an example.
 * The two secrets are demo values and are named as such; a deployment overrides them from
 * `SPA_AUTH__SESSION_SECRET` and `SPA_AUTH__COOKIE_SECRET`.
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
    // Signs the CSRF plugin's own cookie. Separate from the session secret so neither can open the other's.
    cookieSecret: $t.String({ default: 'spa-dashboard-dev-cookie-secret-32chr!!' }),
    // The demo runs on plain http, where a Secure cookie would never be sent back. Turn this on behind TLS.
    secureCookie: $t.Boolean({ default: false }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

/** The key the resolved configuration is bound under, declared beside the schema it is typed from. */
export const kConfig = token<Config>(Symbol('spa-dashboard.config'))

/** The session cookie's name. Fixed here so the tests can read it off `Set-Cookie`. */
export const SESSION_COOKIE = 'spa.session'

/** The CSRF plugin's secret cookie. Logout clears it, so the name is needed in two places. */
export const CSRF_COOKIE = '_csrf'

/**
 * Builds the configuration the application resolves at `ready()`.
 *
 * A function rather than a built value, so importing this module reads no environment and each test builds a
 * fresh one.
 */
export function configuration() {
  return newConfiguration(ConfigSchema, kConfig)
    .source(new EnvConfigSource({ prefix: 'SPA_' }))
    .build()
}
