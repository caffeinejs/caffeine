import { fileURLToPath } from 'node:url'

import { newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { YAMLConfigSource } from '@caffeinejs/application/config/yaml'
import { $t } from '@caffeinejs/application/schema'

/**
 * The shape of `config/application.yaml`, and of every profile file layered over it.
 *
 * The values live in the file, so the schema declares types and constraints and no defaults: a key the file
 * misses fails the load instead of running on a value nobody wrote down. Secrets are `${env:...}` placeholders
 * in the file, read from the environment when the source loads.
 *
 * `DATABASE_URL` is the one value outside this schema, and on purpose. `prisma.config.ts` reads it for
 * `prisma migrate` and the seed, and the driver adapter in `src/util/db/prisma.ts` reads it for the client.
 * `main.ts` and `prisma.config.ts` load `.env` for it, and for the variables the placeholders read.
 */
export const ConfigSchema = $t.Object({
  // Handed to `.server(...)` as the listen options, so the keys are Fastify's.
  server: $t.Object({
    host: $t.String(),
    port: $t.Number(),
  }),
  log: $t.Object({
    level: $t.String(),
  }),
  devtools: $t.Object({
    host: $t.String(),
    port: $t.Integer({ minimum: 0, maximum: 65_535 }),
  }),
  docs: $t.Object({
    user: $t.String(),
    password: $t.String(),
  }),
  auth: $t.Object({
    github: $t.Object({
      clientId: $t.String(),
      clientSecret: $t.String(),
      callbackUrl: $t.String(),
      sessionSecret: $t.String(),
    }),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

const conf = newConfiguration(ConfigSchema)
  .source(new YAMLConfigSource(fileURLToPath(new URL('../config/application.yaml', import.meta.url))))
  .build()

/**
 * The configuration the application resolves at `bootstrap()`. Data only: importing this module reads no file,
 * the source reads it when the application loads.
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
