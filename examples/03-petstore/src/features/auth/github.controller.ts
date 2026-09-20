import { AllowAnonymous, AuthenticationService, Authorize, type Context, Controller, Get } from '@caffeinejs/http'
import { APIGroup } from '@caffeinejs/openapi'
import { View } from '@caffeinejs/view'

// The pages around the GitHub sign-in. The sign-in itself needs no controller: the scheme registers the route
// that starts it (/login/github, its `loginPath`) and the one GitHub comes back to (/login/github/callback).
//
// Hidden from the OpenAPI document: these are browser redirects and rendered pages, not API operations. The
// GitHub scheme itself still appears under components.securitySchemes, derived from .authentication(...).
@APIGroup({ hidden: true })
@Controller('/', [AuthenticationService])
export class GithubAuthController {
  constructor(private readonly auth: AuthenticationService) {}

  // Post-login landing page: a small HTML profile of whoever is signed in.
  // Rendered from src/views/dashboard.hbs; Handlebars auto-escapes the model, so no manual escaping.
  @Get('/dashboard', p => [p.context()])
  @Authorize()
  dashboard(ctx: Context) {
    const user = ctx.user
    const name = user.findFirst('name')?.value ?? user.findFirst('login')?.value ?? 'there'
    const sub = user.findFirst('sub')?.value
    const email = user.findFirst('email')?.value
    const avatarRaw = user.findFirst('avatar_url')?.value
    // Only render a plain https image URL — never inject an arbitrary attacker-influenced string as a src.
    const avatar = typeof avatarRaw === 'string' && avatarRaw.startsWith('https://') ? avatarRaw : undefined
    const authType = user.identities.map(i => i.authenticationType).join(', ') || 'unknown'
    const roles = user.findAll('roles').flatMap(c => (Array.isArray(c.value) ? c.value : [c.value]))

    const rows = [
      { label: 'Subject', value: sub ?? '—' },
      { label: 'Email', value: email ?? '—' },
      { label: 'Signed in via', value: authType },
      { label: 'Roles', value: roles.length ? roles.join(', ') : '—' },
    ]

    return View('dashboard', {
      name,
      avatar,
      rows,
      title: 'Petstore — Signed in',
    })
  }

  // Signs the user out and returns home. Anonymous so signing out never 401s.
  //
  // `signOut` ends the session everywhere the scheme reaches. For GitHub that is here: OAuth 2.0 has no
  // end-session endpoint, so the request is still this handler's to answer. Under an OpenID Connect scheme the
  // same call would send the browser to the provider, and the redirect below would go.
  @Get('/logout', p => [p.context()])
  @AllowAnonymous()
  async logout(ctx: Context) {
    await this.auth.signOut(ctx, 'GitHub')
    ctx.redirect('/')
  }

  // Machine-readable principal for API clients. Accepts either scheme.
  @Get('/me', p => [p.context()])
  @Authorize()
  me(ctx: Context) {
    const user = ctx.user
    return {
      authenticated: user.authenticated,
      authenticationType: user.identities.map(i => i.authenticationType),
      sub: user.findFirst('sub')?.value,
      name: user.findFirst('name')?.value ?? user.findFirst('login')?.value,
      email: user.findFirst('email')?.value,
      roles: user.findAll('roles').flatMap(c => (Array.isArray(c.value) ? c.value : [c.value])),
    }
  }
}
