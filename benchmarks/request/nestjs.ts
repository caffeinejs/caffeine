import 'reflect-metadata'
import {
  Body, CallHandler, CanActivate, Controller, ExecutionContext, Get,
  Headers, Injectable, Module, NestInterceptor, Param, ParseBoolPipe,
  ParseIntPipe, Post, Query, Res, UnauthorizedException, UseGuards,
  UseInterceptors, ValidationPipe,
} from '@nestjs/common'
import { IsBoolean, IsNumber, IsString } from 'class-validator'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Observable } from 'rxjs'
import { makeBigArray } from './shared.js'

const PORT = parseInt(process.env.PORT ?? '3022', 10)

class TestBodyDto {
  @IsString()
  strBody!: string

  @IsNumber()
  numBody!: number

  @IsBoolean()
  boolBody!: boolean
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

  @Post('/api/test/:strParam/:numParam/:boolParam')
  @UseGuards(new ApiKeyGuard())
  test(
    @Param('strParam') strParam: string,
    @Param('numParam', ParseIntPipe) numParam: number,
    @Param('boolParam', ParseBoolPipe) boolParam: boolean,
    @Query('strQuery') strQuery: string,
    @Query('numQuery', ParseIntPipe) numQuery: number,
    @Query('boolQuery', ParseBoolPipe) boolQuery: boolean,
    @Body() body: TestBodyDto,
    @Headers('x-str-header') xStr: string,
    @Headers('x-num-header') xNum: string,
    @Headers('x-bool-header') xBool: string,

    @Res({ passthrough: true }) res: any,
  ) {
    res.header('x-str-header', xStr)
    res.header('x-num-header', xNum)
    res.header('x-bool-header', xBool)

    return {
      params: { str: strParam, num: numParam, bool: boolParam },
      query: { str: strQuery, num: numQuery, bool: boolQuery },
      body: { str: body.strBody, num: body.numBody, bool: body.boolBody },
      header: {
        str: xStr,
        num: parseInt(xNum, 10),
        bool: xBool === 'true',
      },
      big: this.big,
    }
  }
}

@Module({
  controllers: [TestController],
  providers: [RequestIdInterceptor],
})
class AppModule {}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
app.useGlobalPipes(new ValidationPipe({ transform: true }))
await app.listen(PORT, '0.0.0.0')
