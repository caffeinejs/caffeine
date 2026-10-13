import type { InferConfig } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

/**
 * What the UI's configuration holds, from `devtools.yaml` by default. Every key can be set from the environment too,
 * prefixed `CAFFEINE_DEVTOOLS_`: `CAFFEINE_DEVTOOLS_SERVER__PORT` sets `server.port`.
 *
 * ```yaml
 * server:
 *   port: 9339
 * applications:
 *   orders:
 *     url: http://127.0.0.1:9100/devtools
 *     auth:
 *       basic: { username: ops, password: "${env:ORDERS_DEVTOOLS_PASSWORD}" }
 * ```
 */
export const DevToolsUIConfigSchema = $t.Object({
  /** Where the UI listens. It has no login of its own: keep it on a loopback address. */
  server: $t.Object({
    host: $t.String({ default: '127.0.0.1' }),
    port: $t.Integer({ minimum: 0, maximum: 65_535, default: 9339 }),
  }),
  /** Every application the UI reads, by the name its pages show. */
  applications: $t.Record(
    $t.String(),
    $t.Object({
      /** Where the application serves DevTools: its index, `http://127.0.0.1:9100/devtools`. */
      url: $t.String(),
      /** How long one call to the application may take. Five seconds when unset. */
      timeout: $t.Optional($t.Duration()),
      auth: $t.Optional(
        $t.Object({
          basic: $t.Optional($t.Object({ username: $t.String(), password: $t.String() })),
          bearer: $t.Optional($t.String()),
        }),
      ),
      /** Sent on every call, after the credentials `auth` sets. */
      headers: $t.Optional($t.Record($t.String(), $t.String())),
    }),
    { minProperties: 1 },
  ),
})

export type DevToolsUIConfig = InferConfig<typeof DevToolsUIConfigSchema>

/** One application, as `applications.<name>` in the configuration declares it. */
export type ApplicationConfig = DevToolsUIConfig['applications'][string]
