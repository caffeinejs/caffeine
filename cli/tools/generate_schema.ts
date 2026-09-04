// Writes the editor schema for `.caffeinerc.{json,yaml,yml}`. A TypeBox schema is already a JSON
// Schema object, so the config types and this file cannot drift.

import { buildSchema, SCHEMA_PATH } from './_schema.js'

await Bun.write(SCHEMA_PATH, JSON.stringify(buildSchema(), null, 2) + '\n')
