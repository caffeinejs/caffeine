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
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express'
import type { Response } from 'express'
import { Observable } from 'rxjs'
import { z } from 'zod'

const PORT = parseInt(process.env.PORT ?? '3028', 10)

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
})

@Injectable()
class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>()
    res.header('x-request-id', Math.random().toString(36).slice(2))
    return next.handle()
  }
}

@Injectable()
class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
    if (req.headers['x-api-key'] !== 'benchmark') {
      throw new UnauthorizedException()
    }
    return true
  }
}

@Controller()
@UseInterceptors(RequestIdInterceptor)
class TestController {
  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @UseGuards(ApiKeyGuard)
  @UseInterceptors(StandardSchemaSerializerInterceptor)
  @SerializeOptions({ schema: responseSchema })
  @HttpCode(200)
  test(
    @Param({ schema }) params: Schema,
    @Query({ schema }) query: Schema,
    @Body({ schema }) body: Schema,
    @Headers() headers: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.header('text', headers.text)
    res.header('num', headers.num)
    res.header('bool', headers.bool)

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
    }
  }
}

@Module({
  controllers: [TestController],
  providers: [RequestIdInterceptor],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), { logger: false })
app.useGlobalPipes(new StandardSchemaValidationPipe())

await app.listen(PORT, '0.0.0.0')
