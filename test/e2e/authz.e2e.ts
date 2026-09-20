import {
  $p,
  AllowAnonymous,
  Args,
  AuthorizationService,
  Authorize,
  type Context,
  Controller,
  Get,
  Roles,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'
import { bearer, localJWT } from './internal/tokens.js'

/**
 * The authorization matrix: what a declaration means, asked from outside, for every kind of caller. Both spellings
 * of a route are covered, because a decorator and a router chain reach the same compiler by different roads.
 *
 * The application gates every route that declares nothing (`requireAuthenticatedByDefault`), so a public route is
 * one that says so.
 */

interface Doc {
  id: string
  owner: string
}

const DOCS = new Map<string, Doc>([
  ['1', { id: '1', owner: 'user' }],
  ['2', { id: '2', owner: 'admin' }],
])

@AllowAnonymous()
@Controller('/open')
class OpenController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Controller('/undecorated')
class UndecoratedController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Authorize()
@Controller('/bare')
class BareController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Roles('admin', 'manager')
@Controller('/any-role')
class AnyRoleController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Roles('admin')
@Controller('/both-roles')
class BothRolesController {
  @Roles('manager')
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Authorize({ policy: 'engineering' })
@Controller('/claim')
class ClaimController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Authorize({ policy: 'internal' })
@Controller('/assertion')
class AssertionController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Authorize({ policy: ['engineering', 'internal'] })
@Controller('/several-policies')
class SeveralPoliciesController {
  @Get('/')
  get() {
    return { ok: true }
  }
}

@Authorize()
@Controller('/mixed')
class MixedController {
  @AllowAnonymous()
  @Get('/public')
  open() {
    return { ok: true }
  }

  @Get('/private')
  closed() {
    return { ok: true }
  }
}

@Authorize()
@Controller('/docs', [AuthorizationService])
class DocsController {
  constructor(private readonly authz: AuthorizationService) {}

  @Get('/:id')
  @Args([$p.context()])
  async get(ctx: Context) {
    const doc = DOCS.get(ctx.req.param('id')!)!

    // The decision needs the document, so it is taken here, once it is loaded.
    await this.authz.authorize(ctx, 'owner', doc)

    return doc
  }
}

// Declarations stacked on one route. Each is a requirement of its own, in whichever order they were written.
@Controller('/stacked')
class StackedController {
  @Roles('admin')
  @Authorize({ policy: 'engineering' })
  @Get('/roles-over-policy')
  rolesOverPolicy() {
    return { ok: true }
  }

  @Authorize({ policy: 'engineering' })
  @Roles('admin')
  @Get('/policy-over-roles')
  policyOverRoles() {
    return { ok: true }
  }

  @Roles('admin')
  @Roles('manager')
  @Get('/roles-twice')
  rolesTwice() {
    return { ok: true }
  }
}

// The class says "signed-in users only"; a method adding a rule of its own does not take that back.
@Authorize()
@Controller('/bare-class')
class BareClassController {
  @Authorize({ policy: 'internal' })
  @Get('/with-policy')
  withPolicy() {
    return { ok: true }
  }
}

// The class is public; a method that asks for protection still gets it.
@AllowAnonymous()
@Controller('/open-class')
class OpenClassController {
  @Get('/public')
  open() {
    return { ok: true }
  }

  @Authorize()
  @Get('/private')
  closed() {
    return { ok: true }
  }

  @Roles('admin')
  @Get('/admin')
  admin() {
    return { ok: true }
  }
}

void [
  StackedController,
  BareClassController,
  OpenClassController,
  OpenController,
  UndecoratedController,
  BareController,
  AnyRoleController,
  BothRolesController,
  ClaimController,
  AssertionController,
  SeveralPoliciesController,
  MixedController,
  DocsController,
]

const ok = () => ({ ok: true })

function programmatic() {
  return newRouter('/p').mount(
    newRouter('/open').authorize({ allowAnonymous: true }).get('/', ok),
    newRouter('/undecorated').get('/', ok),
    newRouter('/any-role')
      .authorize({ roles: ['admin', 'manager'] })
      .get('/', ok),
    // A route's own roles are required on top of its group's.
    newRouter('/both-roles')
      .authorize({ roles: ['admin'] })
      .get('/')
      .authorize({ roles: ['manager'] })
      .handler(ok),
    newRouter('/claim').authorize({ policy: 'engineering' }).get('/', ok),
    newRouter('/groups').authorize({ policy: 'on-call' }).get('/', ok),
    // Two declarations on one chain.
    newRouter('/stacked')
      .get('/')
      .authorize({ roles: ['admin'] })
      .authorize({ policy: 'engineering' })
      .handler(ok),
    // A router nested in another: what the inner one declares is added to what the outer one declared.
    newRouter('/admin')
      .authorize({ roles: ['admin'] })
      .get('/', ok)
      .mount(
        newRouter('/reports')
          .authorize({ roles: ['manager'] })
          .get('/', ok),
        // Declared public on purpose, inside a protected router: the explicit opt-out still works...
        newRouter('/status')
          .authorize({ allowAnonymous: true })
          .get('/', ok)
          // ...and a route below it that asks for protection again gets all of it, the outer roles included.
          .get('/detail')
          .authorize({})
          .handler(ok),
      ),
    newRouter('/open-group')
      .authorize({ allowAnonymous: true })
      .get('/', ok)
      .get('/admin')
      .authorize({ roles: ['admin'] })
      .handler(ok),
  )
}

type Caller = 'anonymous' | 'user' | 'manager' | 'admin' | 'adminManager'

const INTERNAL = { 'x-internal': 'yes' }

// [what is declared, path, extra headers, caller -> status]
const MATRIX: Array<[string, string, Record<string, string>, Partial<Record<Caller, number>>]> = [
  ['a route declared public', '/open', {}, { anonymous: 200, user: 200 }],
  ['a route that declares nothing, under a fallback policy', '/undecorated', {}, { anonymous: 401, user: 200 }],
  ['a bare @Authorize', '/bare', {}, { anonymous: 401, user: 200 }],
  ['@Roles naming two roles: either will do', '/any-role', {}, { anonymous: 401, user: 403, manager: 200, admin: 200 }],
  [
    '@Roles on the class and on the method: both are required',
    '/both-roles',
    {},
    { anonymous: 401, user: 403, manager: 403, admin: 403, adminManager: 200 },
  ],
  ['a claim policy', '/claim', {}, { anonymous: 401, user: 403, admin: 403, manager: 200 }],
  // The policy asks about the request, not the caller, so it does not ask for an identity either.
  ['an assertion policy, satisfied', '/assertion', INTERNAL, { anonymous: 200, user: 200 }],
  ['an assertion policy, not satisfied', '/assertion', {}, { anonymous: 401, user: 403 }],
  ['two policies, both satisfied', '/several-policies', INTERNAL, { manager: 200 }],
  ['two policies, only the first satisfied', '/several-policies', {}, { manager: 403 }],
  ['two policies, only the second satisfied', '/several-policies', INTERNAL, { anonymous: 401, user: 403 }],
  ['a method declared public inside a protected class', '/mixed/public', {}, { anonymous: 200 }],
  ['its sibling that declares nothing of its own', '/mixed/private', {}, { anonymous: 401, user: 200 }],
  ['a resource policy, asked about the caller’s own document', '/docs/1', {}, { anonymous: 401, user: 200 }],
  ['a resource policy, asked about someone else’s document', '/docs/2', {}, { user: 403, admin: 200 }],

  [
    '@Roles above @Authorize({ policy }) on one method: both are required',
    '/stacked/roles-over-policy',
    {},
    { anonymous: 401, admin: 403, manager: 403, adminManager: 200 },
  ],
  [
    '@Authorize({ policy }) above @Roles on one method: both are required',
    '/stacked/policy-over-roles',
    {},
    { anonymous: 401, admin: 403, manager: 403, adminManager: 200 },
  ],
  [
    '@Roles twice on one method: both are required',
    '/stacked/roles-twice',
    {},
    { admin: 403, manager: 403, adminManager: 200 },
  ],
  [
    'a bare @Authorize on the class and a policy on the method: signed-in is still required',
    '/bare-class/with-policy',
    INTERNAL,
    { anonymous: 401, user: 200 },
  ],
  ['a public class: a method that declares nothing', '/open-class/public', {}, { anonymous: 200 }],
  ['a public class: a method with a bare @Authorize', '/open-class/private', {}, { anonymous: 401, user: 200 }],
  ['a public class: a method with @Roles', '/open-class/admin', {}, { anonymous: 401, user: 403, admin: 200 }],

  ['router: a group declared public', '/p/open', {}, { anonymous: 200 }],
  [
    'router: a group that declares nothing, under a fallback policy',
    '/p/undecorated',
    {},
    { anonymous: 401, user: 200 },
  ],
  ['router: roles on the group', '/p/any-role', {}, { anonymous: 401, user: 403, manager: 200, admin: 200 }],
  [
    'router: roles on the group and on the route',
    '/p/both-roles',
    {},
    { anonymous: 401, manager: 403, admin: 403, adminManager: 200 },
  ],
  ['router: a claim policy', '/p/claim', {}, { anonymous: 401, user: 403, manager: 200 }],
  // A token carries `groups` as a list, as identity providers send it. The policy asks for one of its members.
  [
    'router: a claim policy asked of a claim that holds a list',
    '/p/groups',
    {},
    { anonymous: 401, user: 403, manager: 200, admin: 200, adminManager: 403 },
  ],
  [
    'router: two declarations on one route',
    '/p/stacked',
    {},
    { anonymous: 401, admin: 403, manager: 403, adminManager: 200 },
  ],
  ['router: the outer router of a nested pair', '/p/admin', {}, { anonymous: 401, manager: 403, admin: 200 }],
  [
    'router: a nested router adds its roles to its parent’s',
    '/p/admin/reports',
    {},
    { anonymous: 401, manager: 403, admin: 403, adminManager: 200 },
  ],
  ['router: a nested router declared public inside a protected one', '/p/admin/status', {}, { anonymous: 200 }],
  [
    'router: a route asking for protection again below that public router',
    '/p/admin/status/detail',
    {},
    { anonymous: 401, user: 403, admin: 200 },
  ],
  ['router: a public group: a route that declares nothing', '/p/open-group', {}, { anonymous: 200 }],
  ['router: a public group: a route with roles', '/p/open-group/admin', {}, { anonymous: 401, user: 403, admin: 200 }],
]

describe('what an authorization declaration means to each caller', () => {
  let running: RunningApp
  let credentials: Record<Caller, string | undefined>

  beforeAll(async () => {
    credentials = {
      anonymous: undefined,
      user: await bearer('user', { roles: ['user'], dept: 'sales', groups: ['sales', 'emea'] }),
      manager: await bearer('manager', { roles: ['manager'], dept: 'eng', groups: ['eng', 'on-call'] }),
      admin: await bearer('admin', { roles: ['admin'], dept: 'sales', groups: 'on-call' }),
      adminManager: await bearer('admin-manager', { roles: ['admin', 'manager'], dept: 'eng', groups: [] }),
    }

    running = await startApp(app =>
      app
        .authentication(auth => auth.addJWTBearer(localJWT))
        .authorization(authz =>
          authz
            .addPolicy('engineering', p => p.requireAuthenticated().claim('dept', 'eng'))
            .addPolicy('on-call', p => p.requireAuthenticated().claim('groups', 'on-call'))
            .addPolicy('internal', p => p.assert(ctx => ctx.req.header('x-internal') === 'yes'))
            .addPolicy('owner', p => p.resource<Doc>((user, doc) => doc.owner === user.findFirst('sub')?.value))
            .requireAuthenticatedByDefault(),
        )
        .mount(programmatic()),
    )
  })

  afterAll(() => running.close())

  const cases = MATRIX.flatMap(([declared, path, headers, expected]) =>
    Object.entries(expected).map(([caller, status]) => ({ declared, path, headers, caller: caller as Caller, status })),
  )

  it.each(cases)('$declared — $caller gets $status', async ({ path, headers, caller, status }) => {
    const authorization = credentials[caller]

    const response = await new Browser().xhr(`${running.origin}${path}`, {
      headers: authorization === undefined ? headers : { ...headers, authorization },
    })

    expect(response.status).toBe(status)
  })
})
