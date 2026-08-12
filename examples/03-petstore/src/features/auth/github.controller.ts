import { AllowAnonymous, AuthenticationService, Authorize, type Context, Controller, Get, Params, type Principal, $p } from '@caffeinejs/http'

// GitHub OAuth sign-in. The callback route (/login/github/callback) is registered automatically by
// the framework's OIDCConfigurer from the configured callbackURL — only the initiation route lives
// here.
@Controller('/', [AuthenticationService])
export class GithubAuthController {
  constructor(private readonly auth: AuthenticationService) {}

  // Starts the flow explicitly: the challenge builds GitHub's authorize URL, sets the sealed state
  // cookie, and 302-redirects. Anonymous so the authz guard does not challenge as Bearer first — the
  // default scheme only redirects to GitHub once a session cookie exists.
  //
  // Already-signed-in requests must NOT re-challenge: the callback redirects back to the URL that
  // started the flow (this route), so a blind challenge here loops forever. Send them to the
  // dashboard instead — which is also the landing page after a fresh sign-in.
  @Get('/login/github')
  @AllowAnonymous()
  @Params([$p.context()])
  async login(ctx: Context) {
    if (ctx.user.authenticated) {
      ctx.redirect('/dashboard')
      return
    }
    await this.auth.challenge(ctx, 'GitHub')
  }

  // Post-login landing page: a small HTML profile of whoever is signed in (GitHub session or JWT).
  @Get('/dashboard')
  @Authorize()
  @Params([$p.context()])
  dashboard(ctx: Context) {
    ctx.header('content-type', 'text/html; charset=utf-8').body(dashboardPage(ctx.user))
  }

  // Clears the GitHub session cookie and returns home. Anonymous so signing out never 401s.
  @Get('/logout')
  @AllowAnonymous()
  @Params([$p.context()])
  async logout(ctx: Context) {
    await this.auth.revoke(ctx, 'GitHub')
    ctx.redirect('/')
  }

  // Machine-readable principal for API clients. Accepts either scheme.
  @Get('/me')
  @Authorize()
  @Params([$p.context()])
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

// Escapes user-supplied values (GitHub name/login/email) before embedding them in the page.
function escapeHTML(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function dashboardPage(user: Principal): string {
  const name = user.findFirst('name')?.value ?? user.findFirst('login')?.value ?? 'there'
  const sub = user.findFirst('sub')?.value
  const email = user.findFirst('email')?.value
  const avatar = user.findFirst('avatar_url')?.value
  const authType = user.identities.map(i => i.authenticationType).join(', ') || 'unknown'
  const roles = user.findAll('roles').flatMap(c => (Array.isArray(c.value) ? c.value : [c.value]))

  // Only render a plain https image URL — never inject an arbitrary attacker-influenced string as a src.
  const avatarImg = typeof avatar === 'string' && avatar.startsWith('https://')
    ? `<img class="avatar" src="${escapeHTML(avatar)}" alt="" width="64" height="64">`
    : ''

  const rows = [
    ['Subject', sub],
    ['Email', email],
    ['Signed in via', authType],
    ['Roles', roles.length ? roles.join(', ') : '—'],
  ]
    .map(([label, value]) => `<tr><th>${label}</th><td>${escapeHTML(value ?? '—')}</td></tr>`)
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Petstore — Signed in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { margin-bottom: .25rem; }
  p.lead { color: #6b7280; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid rgba(127,127,127,.25); }
  th { width: 10rem; color: #6b7280; font-weight: 600; }
  .avatar { border-radius: 50%; vertical-align: middle; margin-bottom: 1rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; flex-wrap: wrap; }
  a.btn {
    display: inline-flex; align-items: center; text-decoration: none; padding: .55rem 1rem;
    border-radius: .5rem; font-weight: 600; border: 1px solid rgba(127,127,127,.35);
  }
  a.btn.primary { background: #24292f; color: #fff; border-color: #24292f; }
  a.btn.primary:hover { background: #1b1f24; }
  code { background: rgba(127,127,127,.18); padding: .1rem .35rem; border-radius: .25rem; }
</style>
</head>
<body>
${avatarImg}
<h1>Welcome, ${escapeHTML(name)} 👋</h1>
<p class="lead">You are signed in to the Petstore API.</p>

<table>${rows}</table>

<div class="actions">
  <a class="btn" href="/me">View raw <code>/me</code> JSON</a>
  <a class="btn primary" href="/logout">Sign out</a>
</div>
</body>
</html>`
}
