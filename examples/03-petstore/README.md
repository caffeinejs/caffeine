# 03 — Petstore (caffeine + Prisma/PostgreSQL)

A CaffeineJS HTTP app modelled on the **Modern Petstore OpenAPI 3.2** specification. It exercises more of
`@caffeinejs/http` than the earlier examples:

- **Both ways of declaring routes**, side by side: `@Controller` classes for pets, users and the browser pages,
  and programmatic `Router` chains for orders and inventories.
- **End-to-end type safety** from those routers to the tests, via `@caffeinejs/brewer` — no codegen and no
  schema file, because the server's type _is_ the client's contract.
- **Persistence** via **Prisma Client** over **PostgreSQL** (no in-memory store).
- **Two layers only**: routes → repository. Repositories own every query and the row → API-DTO mapping; routes
  own validation and status codes.
- **One schema file per feature**, in the `$t` dialect from `@caffeinejs/std/schema`. A `$t` schema is JSON Schema, so
  it compiles straight into a Fastify Ajv validator — and the DTO types are inferred from it with `InferSchema`,
  so nothing is declared twice.
- **Auth**: two segregated schemes — GitHub OAuth 2.0 as the default, and Basic guarding the API docs.
- **Server-side rendering** with `@caffeinejs/html`: JSX components, no template engine and no render step.
- **Multipart upload** (`$multipart.file()`), and the OpenAPI 3.2 **QUERY** search verb.
- **Generated API docs** via `@caffeinejs/openapi`: an OpenAPI 3.2 document derived from the routes themselves —
  controllers and routers alike — plus a Scalar UI at `/docs`.
- **Configuration** in one schema, one file: `src/app.config.ts`. The application does not read
  `process.env` for its own settings. `DATABASE_URL` is Prisma's: the CLI reads it from `prisma.config.ts`,
  and the client reads it through the driver adapter.
- **Structured logging** with pino, at a level the configuration chooses.
- **Kubernetes probes** via `.with(health())`: `/livez`, `/readyz`, `/startupz`, and a database readiness indicator.
- **Graceful shutdown** via `.shutdown()`: a drain that refuses readiness before it stops listening.
- **Dockerised**: `docker-compose` brings up Postgres + the app, runs migrations, seeds demo data.

## Architecture

```
public/site.css                    static assets, served at /static
src/main.ts                        bootstrap: builds the container from the generated graph and runs the app
src/app.ts                         the whole wiring, in install order
src/app.config.ts                  the entire configuration schema, its token, and the cookie names
src/app.log.ts                     the pino logger handed to the application
src/app.container.ts               createContainer(...modules)
src/root.gen.mod.ts                generated module graph (committed; `npm run generate` refreshes it)

src/<feature>/<feature>.schemas.ts every $t schema the feature declares, and the types inferred from them
src/<feature>/<feature>.repository.ts  @Injectable([PrismaClient]) — data access and the row → DTO mapper
src/<feature>/<feature>.controller.ts  @Controller(path, [Repository]) — decorator-declared routes
src/<feature>/<feature>.routes.ts      new Router(path) — programmatic routes
src/<feature>/html/*.tsx           the feature's JSX components, where it renders pages
src/util/html/Layout.tsx           the page chrome every rendered page shares
src/util/db/                       the single PrismaClient handle and its @Provides registration
src/util/errors/                   the global @Catch handlers and the error page
src/util/testing/                  the stubbed GitHub OAuth flow the specs sign in with
prisma/schema.prisma               Pet / User / Order models + enums
prisma/migrations/                 committed migration history (applied with `migrate deploy`)
```

The shared `PrismaClient` is provided once via `@Provides(PrismaClient)` and injected into every repository with
`@Injectable([PrismaClient])`.

## Two ways to declare a route

Both compile to the same thing — the same guards, authorization, validation, error handling and OpenAPI output.
Pets and users are written with decorators:

```ts
@Controller('/pets', [PetsRepository])
export class PetsController {
  @Get('/:id', p => [p.param('id')])
  @Schema({ params: PetIdParamSchema, response: { 200: PetSchema } })
  get(id: string) { … }
}
```

Orders and inventories are written as chains, in `*.routes.ts`, and mounted in `app.ts` with
`.mount(ordersRouter, inventoriesRouter)`:

```ts
export const ordersRouter = new Router('/orders')
  .inject({ repository: OrdersRepository })
  .authorize({})
  .get('/:id')
  .schema({ params: OrderIdParamSchema, response: { 200: OrderSchema } })
  .handler((ctx, deps) => deps.repository.get(ctx.req.param().id))
```

What the chain adds is its **type**: every `.handler()` returns the group re-typed with the route just closed, so
the exported value carries each route's method, path and schemas. `src/orders/orders.test.ts` drives that surface
with `testClient` (which is `@caffeinejs/brewer` plus the application's lifecycle) — a path is never written out,
a verb's response is a union discriminated by status, and a route that is renamed or removed breaks the test at
compile time:

```ts
const response = await client.orders.post({ body: { petId }, headers: session })

if (response.status === 201) {
  const order = await response.json() // typed from the route's 201 schema
}
```

`src/pets/pets.test.ts` is the same application exercised the other way, through `controllerTypedClient`.

## Run it (Docker)

```sh
docker compose -f examples/03-petstore/docker-compose.yml up --build
```

Postgres comes up, `prisma migrate deploy` applies migrations, the seed adds two pets and a demo user
(`alice` / `wonderland`), and the API listens on **http://localhost:3000**. Data survives restarts (named volume
`petstore-pgdata`).

Running it outside Docker (`npm start`) uses the schema default instead — **http://localhost:9999** — because the
port `3000` above comes from `PETSTORE_SERVER__PORT` in `docker-compose.yml`. Substitute it in the commands below
if that is how you are running it.

## Configuration

Everything this app reads from its environment is declared once, in [src/app.config.ts](src/app.config.ts):
the server address, the log level, the docs credentials and the GitHub OAuth settings. Nothing in the
application reads `process.env`.

The one variable outside that schema is `DATABASE_URL`. It has no `PETSTORE_` prefix. `prisma.config.ts`
reads it for `prisma migrate` and the seed. The driver adapter in `src/util/db/prisma.ts` reads it for the
client. `src/main.ts` and `prisma.config.ts` load `.env` so it is set for both.

Every block is optional. A block nobody sets resolves to its field defaults, so `npm start` works with no `.env`
at all — see [.env.example](.env.example) for the variables and their defaults. A double underscore separates
path segments, and each segment folds to lower case, which is why the keys are spelled `clientId` and
`callbackUrl`:

| Variable                              | Sets                              |
| ------------------------------------- | --------------------------------- |
| `PETSTORE_SERVER__PORT`               | `server.port`                     |
| `PETSTORE_LOG__LEVEL`                 | `log.level`                       |
| `PETSTORE_DOCS__USER` / `__PASSWORD`  | the Basic credentials             |
| `PETSTORE_AUTH__GITHUB__CLIENT_ID`    | `auth.github.clientId`            |
| `PETSTORE_AUTH__GITHUB__CALLBACK_URL` | `auth.github.callbackUrl`         |
| `DATABASE_URL`                        | Prisma CLI and the driver adapter |

> Earlier revisions of this example used a `PETSTOREDEMO_AUTH_GITHUB_*` prefix with single underscores. If you
> have an old `.env`, rename those four variables.

## API documentation

The OpenAPI document is generated from the routes themselves and served by the running app:

| URL             | What                                          |
| --------------- | --------------------------------------------- |
| `/docs`         | Scalar API reference, served from this origin |
| `/openapi.json` | The OpenAPI 3.2.0 document                    |
| `/openapi.yaml` | The same document as YAML                     |

There is no endpoint table to maintain here, because there is nothing to maintain it _from_: the paths,
parameters, request bodies, response schemas and security requirements are all read out of what the routes
already declare — `@Schema`, `@Status`, `@Authorize`/`@Roles`/`@AllowAnonymous` and the `$p` pickers on a
controller, `.schema()` and `.authorize()` on a router. `@APIGroup`/`@Operation` (and the `apiGroup()` /
`operation()` extensions the routers use, which are the same implementations) add only what none of those can
express: tag descriptions, summaries and `operationId`s.

Two consequences worth noticing:

- `POST /pets/:id/images` is documented as `multipart/form-data` with a binary `file` part purely because the
  handler takes `$multipart.file('file')`. Nothing says so twice.
- `QUERY /pets` is why the app asks for `.version('3.2.0')` — a 3.1 path item has no field for a method outside
  the fixed set, so a 3.1 document would silently omit the route.

## Auth

Two schemes, deliberately segregated:

| Scheme                 | Covers                                    | How a route selects it                                         |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| **GitHub** (OAuth 2.0) | every application route                   | it is the **default** — no route names a scheme                |
| **Basic**              | `/docs`, `/openapi.json`, `/openapi.yaml` | `.secure(s => s.schemes('Basic'))`, the one scheme-naming site |

A route accepts **only** the schemes it names. So a signed-in GitHub session does not open the documentation, and
Basic credentials do not authenticate the API — which is what makes the split real rather than cosmetic.

`.authentication(...)` is written **first** among the installs in `app.ts`, because the gate has no reserved slot:
it registers exactly where that call appears, so anything installed after it runs only for a request the gate let
through.

The two schemes also challenge differently, because they are obtained differently. Basic answers `401` with
`WWW-Authenticate: Basic`, and the browser prompts. GitHub is a round trip to github.com that ends in a session
cookie, so it answers `302` to a **browser navigation** and `401` to anything else. The `401` names, in `location`
and as `loginURL` in the body, the route of this application that starts the sign-in: `/login/github`, the
scheme's `loginPath`, with where to come back to as `returnTo`. Nothing is started for a caller that cannot go
there, so a page that polls while signed out costs nothing. A redirect an API client cannot follow is worse than
useless: `fetch` follows it itself, lands on github.com, which sends no CORS headers, and the caller sees a
network error rather than "you are not signed in". `.challengeMode('redirect' | 'status')` overrides the choice.

That is also why the Scalar UI shows GitHub as a **cookie** scheme with no "Authorize" button, and why the
document's `servers` entry is the relative `/`. The sign-in cannot happen inside the documentation page —
github.com refuses the browser-side token exchange, and the server would ignore the resulting bearer token
anyway, since it reads only the session cookie. Sign in at `/login/github` first; "Try it" is then same-origin and
the browser attaches the cookie on its own.

Note that the application registers no cookie plugin: `@caffeinejs/http` parses cookies for every request, ahead
of anything an application installs.

```sh
# Public reads need nothing
curl localhost:3000/pets
curl -X QUERY localhost:3000/pets -H 'content-type: application/json' \
  -d '{"criteria":{"species":["DOG"],"ageRange":{"min":12,"max":72}}}'

# The documentation is Basic-protected
curl -i localhost:3000/openapi.json                      # 401 + WWW-Authenticate: Basic
curl -u admin:admin123 localhost:3000/openapi.json       # 200

# Writes need a GitHub session — sign in at http://localhost:3000/login/github in a browser.
# curl does not look like a navigation, so it gets a 401 naming where to sign in:
curl -i -X POST localhost:3000/pets \
  -H 'content-type: application/json' \
  -d '{"species":"DOG","name":"Buddy","ageMonths":24,"price":"150.00"}'   # 401 + location: /login/github?returnTo=%2Fpets

# Ask for HTML and you get the redirect a browser would have followed:
curl -i -H 'accept: text/html' localhost:3000/users/1                     # 302 → github.com
```

The GitHub claim mapper grants every signed-in user the `write:pets` role that the pet write routes gate on. That
means **any GitHub account can write** — fine for a demo, and stated here because it is a decision rather than an
oversight. A real deployment would map the role from org or team membership.

## Pages

The three rendered pages — the landing page, the post-sign-in dashboard and the error page — are JSX components
under each feature's `html/` folder, sharing `src/util/html/Layout.tsx`. `@kitajs/html` has no render step: a JSX
expression _is_ the markup, so a handler returns `HTML(Home({ … }))` and a layout is just a component that takes
children.

It also **escapes nothing** unless a node is marked `safe`. Every value these pages interpolate — a GitHub display
name, an avatar URL, an error message — carries it, because none of that text is this application's own.

## Local development (without Docker)

Needs a reachable PostgreSQL and `DATABASE_URL` (copy `.env.example` → `.env`).

Open **http://localhost:9999**, not the `http://127.0.0.1:9999` the startup log prints for a wildcard bind. The
GitHub callback URL names `localhost`, and the sign-in sets its state cookie for the host the browser is on: a
sign-in started on `127.0.0.1` comes back to `localhost` without it and fails with `missing state cookie`. The
log says so with a second line whenever the two differ.

Root `npm run build` (`tsc`) does **not** produce the `caffeine` CLI binary. Build it once (after clone, clean, or
whenever `node_modules/.bin/caffeine` is missing) before generate/build:

```sh
npm run build:cli   # bun-compile @caffeinejs/cli + link node_modules/.bin/caffeine
# or: make build:cli
```

Then:

```sh
npm run build -w @caffeinejs/example-petstore   # prisma generate + caffeine generate modules + tsc
npm run db:migrate:dev -w @caffeinejs/example-petstore   # author/apply migrations
npm run db:seed -w @caffeinejs/example-petstore
npm start -w @caffeinejs/example-petstore
```

The generated module graph (`src/**/*.gen.mod.ts`) is **committed**, so a clone builds without running the CLI.
Re-run `npm run generate -w @caffeinejs/example-petstore` after adding, moving or removing a file that declares an
injectable, and commit what changes.

## Out of scope / Limitations

This example deliberately covers only the parts of the specification that map cleanly onto current caffeine
capabilities. The following are **not** implemented:

- **SSE chat** (`POST /chat/completions`) — caffeine has no response-streaming/Server-Sent-Events helper yet.
- **Webhooks / callbacks** on orders (`callbackOrder`, `orderProcessed`) — no callback machinery.
- **Order payment** (`POST /orders/:id/payment`) — relies on polymorphic (`oneOf`/discriminator) payment sources
  that are not modelled here.
- **OAuth 2.0 device flow** and the full authorization-code/scopes matrix — auth is simplified to a single GitHub
  OAuth scheme whose claim mapper grants the `write:pets` role.
- **RFC 9457 problem+json** error bodies — this example's error handler emits `{ code, message, errors? }` (see
  `src/util/errors/`), not `application/problem+json`.
- **Rate-limit headers** (`RateLimit-*`), `x-codeSamples`, and hierarchical `tags`/`links`/tenant (`X-Tenant-ID`)
  isolation.

Notes:

- Trailing slashes are **not** ignored: `GET /pets/` does not list pets. It is matched as `/pets/:id` with an
  empty `id`, which fails the parameter schema and answers `400`. That is Fastify's default, and this example no
  longer overrides it with `routerOptions: { ignoreTrailingSlash: true }`.
- Passwords are stored in clear text to keep the example small — **never** do this in production; hash with
  argon2/bcrypt.
- The Order model follows the specification's `#/components/schemas/Order` (id, petId, userId, status,
  totalAmount, currency, timestamps); `totalAmount`/`currency` default from the referenced pet when omitted on
  create.
