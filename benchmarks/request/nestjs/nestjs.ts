import 'reflect-metadata'
import {
  Body, CallHandler, CanActivate, Controller, ExecutionContext, Get,
  Headers, HttpCode, Injectable, Module, NestInterceptor, Param, Post,
  Query, Res, UnauthorizedException, UseGuards, UseInterceptors, ValidationPipe,
} from '@nestjs/common'
import { Transform, Type } from 'class-transformer'
import { IsBoolean, IsInt, IsNotEmpty, IsString } from 'class-validator'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Observable } from 'rxjs'
import { FastifyReply } from 'fastify'
import { makeBigArray } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3022', 10)

class Schema {
  @IsString()
  @IsNotEmpty()
  text!: string

  @IsInt()
  @Type(() => Number)
  num!: number

  @IsBoolean()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  bool!: boolean
}

@Injectable()
class RequestIdInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = _context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>()
    res.header('x-request-id', Math.random().toString(36)
      .slice(2))
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

@Controller()
@UseInterceptors(RequestIdInterceptor)
class TestController {
  private readonly big = makeBigArray()

  @Get('/health')
  health() {
    return { ok: true }
  }

  @Post('/api/test/:text/:num/:bool')
  @UseGuards(new ApiKeyGuard())
  @HttpCode(200)
  test(
    @Param() params: Schema,
    @Query() query: Schema,
    @Body() body: Schema,
    @Headers('text') hText: string,
    @Headers('num') hNum: string,
    @Headers('bool') hBool: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    res.header('text', hText)
    res.header('num', hNum)
    res.header('bool', hBool)

    return {
      params: { text: params.text, num: params.num, bool: params.bool },
      query: { text: query.text, num: query.num, bool: query.bool },
      body: { text: body.text, num: body.num, bool: body.bool },
      header: { text: hText, num: parseInt(hNum, 10), bool: hBool === 'true' },
      big: this.big,
    }
  }
}

@Module({
  controllers: [TestController],
  providers: [RequestIdInterceptor],
})
class AppModule { }

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
app.useGlobalPipes(new ValidationPipe({ transform: true }))

await app.listen(PORT, '0.0.0.0')
