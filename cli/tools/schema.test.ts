import { describe, expect, it } from 'bun:test'

import { buildSchema, SCHEMA_PATH } from './_schema.js'

describe('caffeinerc.schema.json', () => {
  // The checked-in schema is a build artifact of the config types. Regenerate it with
  // `npm run generate:schema -w @caffeinejs/cli`.
  it('matches the config types', async () => {
    const onDisk = (await Bun.file(SCHEMA_PATH).json()) as unknown
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildSchema())) as unknown)
  })
})
