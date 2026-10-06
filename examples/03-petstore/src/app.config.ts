import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { $t } from '@caffeinejs/std/schema'

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
 *
 * `DATABASE_URL` is the one value outside this schema, and on purpose. `prisma.config.ts` reads it for
 * `prisma migrate` and the seed, and the driver adapter in `src/util/db/prisma.ts` reads it for the client.
 * It has no `PETSTORE_` prefix and nothing here declares it. `main.ts` and `prisma.config.ts` load `.env` for it.
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
      // Also the host to browse the application from. The sign-in sets its state cookie for the host the
      // browser is on, and GitHub sends the browser back here; `localhost` and `127.0.0.1` are different hosts
      // to a browser, so a sign-in started on the other one comes back without its cookie.
      callbackUrl: $t.String({ default: 'http://localhost:9999/login/github/callback' }),
      // The OAuth scheme requires at least 32 characters, so the fallback is one.
      sessionSecret: $t.String({ default: 'petstore-dev-session-secret-32-chars!!' }),
    }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

const conf = newConfiguration(ConfigSchema)
  .source(new EnvConfigSource({ prefix: 'PETSTORE_' }))
  .build()

/**
 * The configuration the application resolves at `bootstrap()`. Data only: importing this module reads no
 * environment, the source reads it when the application loads.
 */
export const configuration = conf.config

/** The key the configuration the application started with is bound under, typed from the schema. */
export const kConfig = conf.configToken

/** Fixed name for the GitHub session cookie. `app.ts` sets it on the scheme, and the tests present it. */
export const GITHUB_SESSION_COOKIE = 'petstore_gh_session'

/** Fixed name for the per-flow GitHub state cookie. */
export const GITHUB_STATE_COOKIE = 'petstore_gh_state'

/** Whether real GitHub credentials were configured. Shapes the home page's copy. */
export function githubConfigured(config: Config): boolean {
  return config.auth.github.clientId !== 'dev-github-client-id'
}
