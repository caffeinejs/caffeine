import {
  Authorize,
  Controller,
  Get,
  JWTService,
  Post,
  Status,
  createWebApplication,
  Authentication,
  authentication,
} from '@caffeinejs/http'

import { AUDIENCE, ISSUER, ROLE, SECRET } from '../shared.js'

const PORT = parseInt(process.env.PORT ?? '3040', 10)

@Controller('', [JWTService])
class AppController {
  constructor(readonly jwt: JWTService) {}

  @Post('/token')
  async token() {
    return { access_token: await this.jwt.sign({ roles: [ROLE] }) }
  }

  @Authorize({ roles: [ROLE] })
  @Status(200)
  @Get('/protected')
  protected() {
    return ''
  }
}

void [AppController]

const app = createWebApplication()
  .install(
    Authentication(auth => auth.addJWTBearer(b => b.secret(SECRET).issuer(ISSUER).audience(AUDIENCE).expiresIn('1h'))),
  )
  .with(authentication())

await app.run({ port: PORT, host: '0.0.0.0' })
