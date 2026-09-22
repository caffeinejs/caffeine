import 'reflect-metadata'
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager'
import { Controller, Get, Module } from '@nestjs/common'
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'

import { PRODUCTS, TTL_SECONDS } from '../payload.js'

const PORT = parseInt(process.env.PORT ?? '3052', 10)
const cached = process.env.BENCH_CACHE !== 'off'

@Controller()
class ProductsController {
  @Get('health')
  health() {
    return { ok: true }
  }

  @Get('api/products')
  products() {
    return PRODUCTS
  }
}

// The interceptor caches the handler's return value under the request URL, for GET requests, and serializes
// it again on every hit. Registered application-wide, as an application would.
@Module({
  imports: cached ? [CacheModule.register({ ttl: TTL_SECONDS * 1000 })] : [],
  controllers: [ProductsController],
  providers: cached ? [{ provide: APP_INTERCEPTOR, useClass: CacheInterceptor }] : [],
})
class AppModule {}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })

await app.listen(PORT, '0.0.0.0')
