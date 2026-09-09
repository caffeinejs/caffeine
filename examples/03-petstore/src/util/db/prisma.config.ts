import { Configuration, OnLifecycle, Provides } from '@caffeinejs/di'
import { PrismaClient } from '@prisma/client'

import { prisma } from './prisma.js'

// Registers the shared PrismaClient under the `PrismaClient` token so repositories can inject it
// via `@Injectable([PrismaClient])`. The container disconnects it on dispose, which runs after the
// drain delay and after the server has stopped — no in-flight query loses its connection mid-query.
@Configuration()
export class PrismaConfig {
  @OnLifecycle<PrismaClient>({ destroy: client => client.$disconnect() })
  @Provides(PrismaClient)
  client(): PrismaClient {
    return prisma
  }
}
