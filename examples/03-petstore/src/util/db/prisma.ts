import { token } from '@caffeinejs/di'
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../../../generated/prisma/client.js'

// Single process-wide Prisma handle. Exported so index.ts can disconnect it on shutdown and the
// DI configuration below can hand the same instance to every repository.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
export const prisma = new PrismaClient({ adapter })

// The key the container binds the client under. Prisma builds `PrismaClient` at runtime from a minified class
// named `t`, so binding under the class itself would name the binding, and every edge to it, `t`.
export const kPrisma = token<PrismaClient>(Symbol.for('prisma.client'))
