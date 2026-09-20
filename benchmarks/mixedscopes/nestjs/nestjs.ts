import 'reflect-metadata'
import {
  Body,
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Module,
  NestInterceptor,
  Param,
  Post,
  Query,
  Res,
  Scope,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyReply } from 'fastify'
import { Observable } from 'rxjs'
import { z } from 'zod'

const PORT = parseInt(process.env.PORT ?? '3031', 10)

// The validation and serialization of the request benchmark's Nest fixture, so the two differ by the
// request-scoped dependency and nothing else.
const schema = z.object({
  text: z.string(),
  num: z.coerce.number().int(),
  bool: z.preprocess(v => v === 'true' || v === true, z.boolean()),
})
type Schema = z.infer<typeof schema>

const responseSchema = z.object({
  params: schema,
  query: schema,
  body: schema,
  header: schema,
})

@Injectable()
class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>()
    res.header('x-request-id', Math.random().toString(36).slice(2))
    return next.handle()
  }
}

class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
    if (req.headers['x-api-key'] !== 'benchmark') {
      throw new UnauthorizedException()
    }
    return true
  }
}

@Injectable()
class AppConfig {
  readonly name = 'benchmark'
}

@Injectable({ scope: Scope.REQUEST })
class AppLogger {
  constructor(private readonly config: AppConfig) {}
  log(_msg: string): void {
    /* no-op */
  }
}

@Injectable()
class TestRepository {
  constructor(private readonly config: AppConfig) {}
  find(): unknown[] {
    return []
  }
}

// REQUEST-scoped due to NestJS scope propagation from AppLogger
@Controller()
@UseInterceptors(RequestIdInterceptor)
class TestController {
  constructor(
    private readonly repo: TestRepository,
    private readonly logger: AppLogger,
  ) {}

  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @UseGuards(new ApiKeyGuard())
  @UseInterceptors(StandardSchemaSerializerInterceptor)
  @SerializeOptions({ schema: responseSchema })
  @HttpCode(200)
  test(
    @Param({ schema }) params: Schema,
    @Query({ schema }) query: Schema,
    @Body({ schema }) body: Schema,
    @Headers() headers: Record<string, string>,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    this.logger.log('request')

    // @Headers() takes no schema, so the headers the caffeine fixture validates are parsed here.
    const header = schema.parse(headers)

    res.header('text', header.text)
    res.header('num', header.num.toString())
    res.header('bool', header.bool.toString())

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
      header: { text: header.text, num: header.num, bool: header.bool },
    }
  }
}

@Module({
  controllers: [TestController],
  providers: [AppConfig, AppLogger, TestRepository, RequestIdInterceptor],
})
class AppModule {}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
app.useGlobalPipes(new StandardSchemaValidationPipe())

await app.listen(PORT, '0.0.0.0')
