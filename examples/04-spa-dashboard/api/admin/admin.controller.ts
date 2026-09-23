import { Authorize, Controller, Get } from '@caffeinejs/http'
import { APIGroup } from '@caffeinejs/openapi'

import { Users } from '../auth/users.js'

/**
 * Administration, behind a role.
 *
 * `@Authorize({ roles: ['admin'] })` on the class covers every route in it. A signed-in member reaching this
 * gets 403 from the cookie scheme's `forbid` — and because `forbid` answers a navigation with a redirect to
 * `accessDeniedPath` and everything else with the status, the page and this API get the right answer each.
 */
@APIGroup({ name: 'Administration', description: 'Requires the admin role.' })
@Authorize({ roles: ['admin'] })
@Controller('/api/admin')
export class AdminController {
  @Get('/users')
  users(): unknown {
    return { users: Users.directory() }
  }
}
