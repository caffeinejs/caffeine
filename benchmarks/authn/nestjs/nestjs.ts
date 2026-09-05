import 'reflect-metadata'
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  SetMetadata,
  UseGuards,
} from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { AuthGuard, PassportModule, PassportStrategy } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { ExtractJwt, Strategy } from 'passport-jwt'

import { ROLE, SECRET } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3041', 10)

const ROLES_KEY = 'roles'
const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

interface TokenUser {
  roles?: string[]
}

@Injectable()
class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: SECRET,
    })
  }

  validate(payload: TokenUser): TokenUser {
    return { roles: payload.roles }
  }
}

@Injectable()
class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!requiredRoles) {
      return true
    }

    const { user } = context.switchToHttp().getRequest<{ user: TokenUser }>()
    return requiredRoles.some(role => user.roles?.includes(role))
  }
}

@Controller()
class AppController {
  constructor(private readonly jwt: JwtService) {}

  @Post('/token')
  @HttpCode(200)
  token() {
    return { access_token: this.jwt.sign({ roles: [ROLE] }) }
  }

  @Get('/protected')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLE)
  @HttpCode(200)
  protected() {
    return ''
  }
}

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [AppController],
  providers: [JwtStrategy, RolesGuard],
})
class AppModule {}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false })
await app.listen(PORT, '0.0.0.0')
