import { $p, Args, Controller, Get, type Context } from '@caffeinejs/http'
import { APIGroup } from '@caffeinejs/openapi'

/**
 * Who is signed in, as the dashboard renders it.
 *
 * No `@Authorize` anywhere: the application runs `requireAuthenticatedByDefault()`, so a route that declares
 * nothing is gated. That is the whole point of the default — the route that forgets is the safe one.
 *
 * The browser sends the session cookie on a same-origin `fetch` by itself, so nothing about this controller
 * knows a single-page application is calling it.
 */
@APIGroup({ name: 'Profile', description: 'The signed-in principal.' })
@Controller('/api/profile')
export class ProfileController {
  @Get('/')
  @Args([$p.context()])
  me(ctx: Context): unknown {
    return {
      sub: ctx.user.findFirst('sub')?.value ?? null,
      name: ctx.user.findFirst('name')?.value ?? null,
      roles: ctx.user.findAll('roles').flatMap(claim => (Array.isArray(claim.value) ? claim.value : [claim.value])),
    }
  }
}
