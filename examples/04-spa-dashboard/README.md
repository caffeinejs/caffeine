# 04 — SPA Dashboard (caffeine + a single-page application)

A single-page application and the API it talks to, on one origin, with one authentication scheme. It is the
worked example behind [`ai/docs/spa.md`](../../ai/docs/spa.md): `@caffeinejs/static` serves files and nothing
else, and every client route is a route the application wrote.

- **One authentication scheme for both halves** — `addCookie(...)`. Its session cookie is an encrypted JWT,
  `HttpOnly`, `SameSite=Lax`, so no token is ever in JavaScript and the browser attaches it to same-origin
  `fetch` by itself. The challenge adapts to the caller: a browser navigation is redirected, a `fetch` gets a
  status.
- **Three authorization tiers over one bundle** — public, signed in, and administrators. Each is one
  `authorize` on the application's own router.
- **Two hardcoded accounts** through the framework's credential flow: a `UserProvider`, `CredentialsService`
  and scrypt hashing, with no plaintext comparison anywhere.
- **Both route sources side by side** — `@Controller` classes for `/api/profile` and `/api/admin`, a
  programmatic `newRouter()` for `/api/projects`. They compile identically.
- **CSRF** with `@fastify/csrf-protection` and **security headers** with `@fastify/helmet` — two official
  Fastify plugins the application registers itself, because `@caffeinejs/http` ships no wrapper for either.
- **A real front-end build**: esbuild, content-hashed asset names, and a `.br`/`.gz` beside every file for
  `preCompressed`.
- **OpenAPI** for the API, with the client routes deliberately absent from it.

## Architecture

```
examples/04-spa-dashboard/
├── web/                      the front end
│   ├── build.mjs             esbuild → web/dist, then gzip + brotli every file
│   ├── index.html            template; build.mjs substitutes the hashed names
│   ├── public/               favicon, robots.txt, sitemap.xml, manifest — copied verbatim
│   ├── src/main.js           History-API router, login form, fetch('/api/...')
│   └── dist/                 build output, gitignored — what the server serves
└── api/                      the server
    ├── app.ts                buildApp(container) — the testable factory
    ├── app.config.ts         the $t schema every SPA_* variable folds into
    ├── auth/                 the two accounts, and /auth/csrf · /login · /logout · /me
    ├── profile/              @Controller('/api/profile')
    ├── projects/             newRouter('/api/projects') — the programmatic half
    ├── admin/                @Controller('/api/admin'), behind a role
    └── spa/                  the static mount, the client routes, helmet and CSRF
```

The only path that crosses the boundary is `api/spa/site.ts`, which points the mount at `web/dist`.

## The two rules that make a SPA work

**A path the application declared answers any client; a wildcard answers only a document request.** `/` and
`/index.html` are requests for the document itself, so `curl` and a load-balancer probe get the page.
`/pricing` is a fallback, so it is a page for a browser and a `404` for anything else — which is what keeps a
missing `/assets/main-ABC123.js` a real 404 instead of HTML under a JavaScript content type.

**The API owns its own misses.** One line — `newRouter('/api').get('/*', notFound)` — covers a router base and
two controller bases, and every future one. Without it a browser typing `/api/typo` is handed the application.

## Run it

```sh
npm install                                   # from the repository root
npm run build:cli                             # once: the module-graph generator
npm run build -w @caffeinejs/example-spa-dashboard
npm start -w @caffeinejs/example-spa-dashboard
```

Then open <http://127.0.0.1:9010> and sign in.

| Account | Password   | Roles            | Can reach          |
| ------- | ---------- | ---------------- | ------------------ |
| `admin` | `admin123` | `admin`,`member` | everything         |
| `user`  | `user123`  | `member`         | everything but `/admin` |

## Pages and endpoints

| Path                | Who                | What                                            |
| ------------------- | ------------------ | ----------------------------------------------- |
| `/`, `/about`       | anyone             | client routes, served as the shell               |
| `/login`            | anyone             | the sign-in form. Gating it would loop           |
| `/forbidden`        | anyone             | where a navigation lands on a 403                |
| `/dashboard`        | signed in          | reads `/api/profile`                             |
| `/projects`         | signed in          | reads `/api/projects`                            |
| `/admin`            | role `admin`       | reads `/api/admin/users`                         |
| `/api/profile`      | signed in          | the principal                                    |
| `/api/projects`     | signed in          | programmatic router, with schemas                |
| `/api/admin/users`  | role `admin`       | the account directory                            |
| `/auth/csrf`        | anyone             | a CSRF token; the `_csrf` cookie is `HttpOnly`   |
| `/auth/login`       | anyone             | sets the session cookie, rotates the CSRF secret |
| `/auth/logout`      | anyone             | clears both cookies                              |
| `/auth/me`          | signed in          | the principal, for the client's own state        |
| `/openapi.json`     | signed in          | the document, `.secure('Cookie')`                |
| `/livez`, `/readyz` | anyone             | probes, exempt from authentication entirely      |

Try the split that one scheme buys:

```sh
# a browser navigation is redirected; a fetch is told the status
curl -si -H 'sec-fetch-mode: navigate' -H 'sec-fetch-dest: document' localhost:9010/dashboard | head -1
curl -si -H 'accept: application/json' localhost:9010/api/profile | head -1

# a declared path answers any client, a wildcard does not
curl -si localhost:9010/ | head -1
curl -si localhost:9010/pricing | head -1

# the bundle is pre-compressed, and the compressed file is not a URL of its own
curl -si -H 'accept-encoding: br' localhost:9010/assets/main-*.js | grep -i content-encoding
```

## Configuration

Every value has a default, so the example runs with nothing set. Copy `.env.example` to `.env` to override.

| Variable                   | Sets                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `SPA_SERVER__HOST/PORT`    | what the server listens on                                   |
| `SPA_LOG__LEVEL`           | the log level                                                |
| `SPA_AUTH__SESSION_SECRET` | seals the session cookie. At least 32 characters             |
| `SPA_AUTH__COOKIE_SECRET`  | signs the CSRF cookie. Separate, so neither opens the other's |
| `SPA_AUTH__SECURE_COOKIE`  | `true` behind TLS. On plain http a Secure cookie never returns |

## Security notes

- **No token in JavaScript.** The session is an `HttpOnly` cookie, which is the argument for this shape over a
  bearer token in `localStorage`: a cross-site script cannot read it.
- **CSRF is layered on `SameSite=Lax`, not replaced by it.** `Lax` is scoped to the *site* rather than the
  origin — a sibling subdomain is same-site — it exempts top-level `GET` navigations, and it does nothing in a
  client that does not enforce it. Unsafe methods therefore carry `x-csrf-token` as well.
- **The CSRF secret is rotated when a session begins**, so a token minted before sign-in cannot be replayed
  against the session it created. `generateCsrf()` only mints a new secret when the request carried no `_csrf`
  cookie, so `api/auth/auth.routes.ts` clears the request's own copy first. The plugin has no rotate of its own.
- **Signing out clears both cookies.** The cookie scheme's `revoke` clears its own and knows nothing about any
  other plugin's, so the route does the rest — otherwise the CSRF secret would be inherited by the next user of
  that browser.
- **Content-Security-Policy** is stated rather than inherited. Two helmet defaults are off because this demo
  runs over plain http: `upgrade-insecure-requests` would rewrite every subresource to `https:` on any host
  that is not localhost, and HSTS would be a footgun. Behind TLS, drop both overrides.

## Out of scope

Deliberately absent, so the example stays about serving a single-page application:

- a service worker or offline cache — a second lifecycle with nothing to do with the framework;
- server-side rendering — [`03-petstore`](../03-petstore) covers `@caffeinejs/html`;
- refresh-token rotation (`addRefreshTokens` exists, and doubles the auth surface);
- a database, i18n, and a front-end framework.

Notes:

- The icons are SVG so every file here stays text and reviewable. A real site adds a binary `favicon.ico` for
  older clients, at `/favicon.ico`; nothing about the mount changes.
- `@fastify/csrf-protection`'s README says `generateCsrf` "returns a promise that resolves to the associated
  secret". Its implementation and its types return the **token**, synchronously — do not `await` it. Its
  `logLevel` option is documented but missing from the types, and it declares no plugin `dependencies`, so a
  missing companion plugin surfaces as a request-time 500 rather than a start-up failure.
