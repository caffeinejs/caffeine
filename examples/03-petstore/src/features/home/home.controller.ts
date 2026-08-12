import { AllowAnonymous, type Context, Controller, Get, Params, $p } from '@caffeinejs/http'
import { githubConfigured } from '../auth/index.js'

// Landing page for the Petstore API. Public, HTML — a human-facing index of the API's authentication
// strategies (GitHub sign-in and the JWT token endpoint). Everything is inlined: no template engine,
// no external assets.
@Controller('/')
export class HomeController {
  @Get('/')
  @AllowAnonymous()
  @Params([$p.context()])
  home(ctx: Context) {
    ctx.header('content-type', 'text/html; charset=utf-8').body(page())
  }
}

function page(): string {
  const githubNote = githubConfigured
    ? ''
    : '<p class="warn">GitHub credentials are not configured. Set the '
      + '<code>PETSTOREDEMO_AUTH_GITHUB_*</code> environment variables to enable sign-in.</p>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Petstore API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { margin-bottom: .25rem; }
  p.lead { color: #6b7280; margin-top: 0; }
  section { margin-top: 2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  a.btn {
    display: inline-flex; align-items: center; gap: .5rem; text-decoration: none;
    background: #24292f; color: #fff; padding: .6rem 1rem; border-radius: .5rem; font-weight: 600;
  }
  a.btn:hover { background: #1b1f24; }
  code { background: rgba(127,127,127,.18); padding: .1rem .35rem; border-radius: .25rem; }
  p.warn { color: #b45309; }
  footer { margin-top: 3rem; color: #9ca3af; font-size: .85rem; }
</style>
</head>
<body>
<h1>Petstore API</h1>
<p class="lead">A caffeine example. Sign in below or call the API directly.</p>

<section>
  <h2>Sign in with GitHub</h2>
  <p>OAuth 2.0 browser login. Sets a session cookie you can verify at <code>/me</code>.</p>
  <a class="btn" href="/login/github">
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    Sign in with GitHub
  </a>
  ${githubNote}
</section>

<section>
  <h2>JWT bearer (API)</h2>
  <p>Programmatic access. Exchange credentials for a token, then send it as a bearer header.</p>
  <p><code>POST /auth/tokens</code> with <code>{ "username", "password" }</code> &rarr; <code>{ "token" }</code></p>
  <p><code>GET /me</code> with <code>Authorization: Bearer &lt;token&gt;</code> returns the current principal.</p>
</section>

<footer>Public endpoints: <code>GET /pets</code>, <code>GET /pets/:id</code>.</footer>
</body>
</html>`
}
