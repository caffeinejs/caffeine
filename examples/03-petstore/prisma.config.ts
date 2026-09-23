import 'dotenv/config'
import path from 'node:path'

import { defineConfig } from 'prisma/config'

// A prisma.config.ts disables Prisma's automatic .env loading, so load it explicitly here.
// `prisma generate` does not connect. CI runs it with DATABASE_URL unset, so an absent URL is an
// empty string here. migrate and seed fail later if it is still missing.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
})
