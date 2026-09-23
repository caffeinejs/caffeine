import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../../../generated/prisma/client.js'

// Single process-wide Prisma handle. Exported so index.ts can disconnect it on shutdown and the
// DI configuration below can hand the same instance to every repository.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
export const prisma = new PrismaClient({ adapter })
