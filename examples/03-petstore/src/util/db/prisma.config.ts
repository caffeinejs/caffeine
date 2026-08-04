import { Configuration, Provides } from '@caffeinejs/di'
import { PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'

// Registers the shared PrismaClient under the `PrismaClient` token so repositories can inject it
// via `@Injectable([PrismaClient])`.
@Configuration()
export class PrismaConfig {
  @Provides(PrismaClient)
  client(): PrismaClient {
    return prisma
  }
}
