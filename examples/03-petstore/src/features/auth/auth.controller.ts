import { Controller, ErrHTTPUnauthorized, Params, Post, Schema, $p } from '@caffeinejs/http'
import { UsersRepository } from '../users/users.repository.js'
import { signToken } from './tokens.js'

interface LoginDTO {
  username: string
  password: string
}

const loginSchema = {
  type: 'object',
  required: ['username', 'password'],
  properties: {
    username: { type: 'string' },
    password: { type: 'string' },
  },
}

@Controller('/auth', [UsersRepository])
export class AuthController {
  constructor(private readonly users: UsersRepository) {}

  // POST /auth/tokens — verifies credentials and mints a JWT. Grants the `write:pets` scope so the
  // returned token can exercise the guarded pet write routes in this demo.
  @Post('/tokens')
  @Schema({ body: loginSchema })
  @Params([$p.body()])
  async createToken(dto: LoginDTO) {
    const userId = await this.users.verifyCredentials(dto.username, dto.password)
    if (!userId) {
      throw new ErrHTTPUnauthorized('Invalid credentials')
    }
    const token = await signToken(userId, ['write:pets'])
    return { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  }
}
