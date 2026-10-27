import { Configuration, OnLifecycle, Provides } from '@caffeinejs/di'

import { PrismaClient } from '../../../generated/prisma/client.js'
import { kPrisma, prisma } from './prisma.js'

// Registers the shared PrismaClient under the `kPrisma` token so repositories can inject it
// via `@Injectable([kPrisma])`. The container disconnects it on dispose, which runs after the
// drain delay and after the server has stopped — no in-flight query loses its connection mid-query.
@Configuration()
export class PrismaConfig {
  @OnLifecycle({ destroy: client => client.$disconnect() })
  @Provides(kPrisma)
  client(): PrismaClient {
    return prisma
  }
}
