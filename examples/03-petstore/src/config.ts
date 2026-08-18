import { z } from 'zod'

// The application config schema. Any Standard Schema library works; this example uses zod v4. Values come from
// the environment (see app.ts): `z.coerce.number()` turns PETSTORE_SERVER__PORT into a number. Field defaults
// fill a partial server (e.g. docker sets only the port), and the object default covers a wholly-absent server.
// The values appear twice because zod's `.default(v)` short-circuits (returns `v` as-is without re-parsing), so
// a field default cannot fill an object that is missing entirely.
export const appConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().default(9999),
  }).default({ host: '0.0.0.0', port: 9999 }),
})

export type AppConfig = z.infer<typeof appConfigSchema>
