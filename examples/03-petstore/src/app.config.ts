import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { EnvConfigSource, type InferConfig } from '@caffeinejs/std/config'

/**
 * Everything this application reads from its environment, in one schema.
 *
 * Values arrive as strings and are coerced to the declared types: `PETSTORE_SERVER__PORT` becomes a number
 * because the schema says so, with no coercion wrapper at the call site. A block nobody set resolves to its
 * field defaults, so the application runs with no configuration at all.
 *
 * Keys are spelled the way an environment variable folds — `clientId`, not `clientID` — because
 * `EnvConfigSource` lowercases each path segment and only `CLIENT_I_D` would reach the other spelling. The
 * TypeScript identifiers they feed still follow the repository's acronym rules, so `clientId` is handed to
 * `.clientID(...)`.
 */
export const ConfigSchema = $t.Object({
  // What the server listens on. Handed to `.server(...)` as the listen options, so the keys are Fastify's.
  server: $t.Object({
    host: $t.String({ default: '0.0.0.0' }),
    port: $t.Number({ default: 9999 }),
  }),
  log: $t.Object({
    level: $t.String({ default: 'info' }),
  }),
  // Basic credentials for the API documentation. Demo defaults so the example runs with no setup.
  docs: $t.Object({
    user: $t.String({ default: 'admin' }),
    password: $t.String({ default: 'admin123' }),
  }),
  auth: $t.Object({
    github: $t.Object({
      // Placeholders keep the application startable with nothing configured: the OAuth scheme refuses empty
      // credentials, and a sign-in needs real ones to reach GitHub at all.
      clientId: $t.String({ default: 'dev-github-client-id' }),
      clientSecret: $t.String({ default: 'dev-github-client-secret' }),
      callbackUrl: $t.String({ default: 'http://localhost:9999/login/github/callback' }),
      // The OAuth scheme requires at least 32 characters, so the fallback is one.
      sessionSecret: $t.String({ default: 'petstore-dev-session-secret-32-chars!!' }),
    }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

/**
 * The key the resolved configuration is bound under, declared beside the schema it is typed from so
 * `container.get(kConfig)` needs no type argument at the call site.
 */
export const kConfig = token<Config>(Symbol('petstore.config'))

/** Fixed name for the GitHub session cookie. `app.ts` sets it on the scheme, and the tests present it. */
export const GITHUB_SESSION_COOKIE = 'petstore_gh_session'

/** Fixed name for the per-flow GitHub state cookie. */
export const GITHUB_STATE_COOKIE = 'petstore_gh_state'

/**
 * Builds the configuration the application resolves at `ready()`.
 *
 * A function rather than a built value, so importing this module reads no environment and a test can build a
 * fresh one.
 */
export function configuration() {
  return newConfiguration(ConfigSchema, kConfig)
    .source(new EnvConfigSource({ prefix: 'PETSTORE_' }))
    .build()
}

/** Whether real GitHub credentials were configured. Shapes the home page's copy. */
export function githubConfigured(config: Config): boolean {
  return config.auth.github.clientId !== 'dev-github-client-id'
}
