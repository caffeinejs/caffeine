import { token } from '@caffeinejs/di'
import { type InferSchema, $t } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'

// The application config schema, in Caffeine's `$t` dialect. Values come from the environment (see app.ts) as
// strings, and are coerced to the declared types: PETSTORE_SERVER__PORT becomes a number because the schema says
// `$t.Number`, with no coercion wrapper at the call site.
//
// Defaults are declared once. `{ default: {} }` on `server` materializes the object when the environment sets
// nothing at all, and the field defaults then fill it in — so a partially configured server (docker setting only
// the port) and a wholly absent one are both covered by the same two values.
export const appConfigSchema = $t.Object({
  server: $t.Object(
    {
      host: $t.String({ default: '0.0.0.0' }),
      port: $t.Number({ default: 9999 }),
    },
    { default: {} },
  ),
})

export type AppConfig = InferSchema<typeof appConfigSchema>

// The key the resolved configuration is bound under. Declared here, next to the schema it is typed from, so
// `container.get(kAppConfig)` hands back a typed handle with no type argument at the call site.
export const kAppConfig = token<ConfigHandle<AppConfig>>(Symbol('petstore.config'))
