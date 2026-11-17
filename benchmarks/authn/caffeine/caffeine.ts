import {
  Authorize,
  Controller,
  Get,
  JWTService,
  Post,
  Status,
  Authentication,
  authentication,
  createWebApplication,
} from '@caffeinejs/http'
import { node } from '@caffeinejs/http/node'
import { Hour } from '@caffeinejs/std/duration'

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

const app = createWebApplication({ adapter: node() })
  .install(
    Authentication(auth =>
      auth.addJWTBearer(b =>
        b
          .secret(SECRET)
          .issuer(ISSUER)
          .audience(AUDIENCE)
          .expiresIn(1 * Hour),
      ),
    ),
  )
  .with(authentication())

await app.run({ port: PORT, host: '0.0.0.0' })
