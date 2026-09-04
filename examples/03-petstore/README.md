# 03 — Petstore (caffeine + Prisma/PostgreSQL)

A CaffeineJS HTTP app modelled on the **Modern Petstore OpenAPI 3.2** spec
([spec/openapi.petstore.yaml](./spec/openapi.petstore.yaml)). It exercises more of
`@caffeinejs/http` than the earlier examples:

- **Persistence** via **Prisma Client** over **PostgreSQL** (no in-memory store).
- **Two layers only**: `controller → repository`. Repositories own every query and the
  row → API-DTO mapping; controllers own routing, validation, and status codes.
- **Request/response validation** with `@Schema`, declared in the `$t` dialect from `@caffeinejs/std` and mirroring the spec. A `$t` schema is JSON Schema, so it compiles straight into a Fastify Ajv validator and carries the TypeScript type with it.
- **Auth**: two segregated schemes — GitHub OAuth 2.0 as the default, and Basic guarding the API docs.
- **Multipart upload** (`$p.file()`), and the OpenAPI 3.2 **QUERY** search verb.
- **Generated API docs** via `@caffeinejs/openapi`: an OpenAPI 3.2 document derived from the routes themselves,
  plus a Scalar UI at `/docs`.
- **Kubernetes probes + graceful shutdown** via `.health()`: `/livez`, `/readyz`, `/startupz`, a database readiness indicator, and a drain that refuses readiness before it stops listening.
- **Dockerised**: `docker-compose` brings up Postgres + the app, runs migrations, seeds demo data.

## Architecture

```
src/main.ts                  bootstrap: builds the app
src/app.ts                   features: QUERY verb, @fastify/multipart, GitHub OAuth, Basic docs auth, health probes
src/features/health/db.health.ts  HealthIndicator — @Injectable, readiness only, never liveness
src/util/db/prisma.ts    single PrismaClient handle
src/util/db/prisma.config.ts  @Configuration + @Provides(PrismaClient) — DI registration
src/<domain>/<name>.ts       API DTOs + JSON schemas + row→DTO mapper
src/<domain>/*.repository.ts  @Injectable([PrismaClient]) — data access
src/<domain>/*.controller.ts  @Controller(path, [Repository]) — routes
prisma/schema.prisma         Pet / User / Order models + enums
prisma/migrations/           committed migration history (applied with `migrate deploy`)
```

The shared `PrismaClient` is provided once via `@Provides(PrismaClient)` and injected into every
repository with `@Injectable([PrismaClient])`.

## Run it (Docker)

```sh
docker compose -f examples/03-petstore/docker-compose.yml up --build
```

Postgres comes up, `prisma migrate deploy` applies migrations, the seed adds two pets and a demo
user (`alice` / `wonderland`), and the API listens on **http://localhost:3000**. Data survives
restarts (named volume `petstore-pgdata`).

Running it outside Docker (`npm run dev`) uses the schema default instead — **http://localhost:9999** —
because the port `3000` above comes from `PETSTORE_SERVER__PORT` in `docker-compose.yml`. Substitute it in the
commands below if that is how you are running it.

## API documentation

The OpenAPI document is generated from the routes themselves and served by the running app:

| URL             | What                                          |
| --------------- | --------------------------------------------- |
| `/docs`         | Scalar API reference, served from this origin |
| `/openapi.json` | The OpenAPI 3.2.0 document                    |
| `/openapi.yaml` | The same document as YAML                     |

There is no endpoint table to maintain here any more, because there is nothing to maintain it _from_: the
paths, parameters, request bodies, response schemas and security requirements are all read out of what the
controllers already declare — `@Schema`, `@Status`, `@Authorize`/`@Roles`/`@AllowAnonymous`, and the `$p`
pickers. `@APIGroup` and `@Operation` add only the parts none of those can express: the tag descriptions, the
summaries, and the `operationId`s that tie each route to `spec/openapi.petstore.yaml`.

Two consequences worth noticing:

- `POST /pets/:id/images` is documented as `multipart/form-data` with a binary `file` part purely because the
  handler takes `$p.file('file')`. Nothing says so twice.
- `QUERY /pets` is why the app asks for `.version('3.2.0')` — a 3.1 path item has no field for a non-standard
  method, so a 3.1 document would silently omit the route (the generator warns and skips it).

`src/openapi.test.ts` asserts the generated `operationId` set matches the specification the example is
modelled on, so a route added without an `@Operation` fails the build rather than drifting quietly.

## Auth

Two schemes, deliberately segregated:

| Scheme                 | Covers                                    | How a route selects it                                         |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| **GitHub** (OAuth 2.0) | every application route                   | it is the **default** — no controller names a scheme           |
| **Basic**              | `/docs`, `/openapi.json`, `/openapi.yaml` | `.secure(s => s.schemes('Basic'))`, the one scheme-naming site |

A route accepts **only** the schemes it names. So a signed-in GitHub session does not open the documentation,
and Basic credentials do not authenticate the API — which is what makes the split real rather than cosmetic.

The two schemes also challenge differently, because they are obtained differently. Basic answers `401` with
`WWW-Authenticate: Basic`, and the browser prompts. GitHub is a round trip to github.com that ends in a
session cookie, so it answers `302` to a **browser navigation** and `401` — carrying the same URL in
`location` — to anything else. A redirect an API client cannot follow is worse than useless: `fetch` follows
it itself, lands on github.com, which sends no CORS headers, and the caller sees a network error rather than
"you are not signed in". `.challengeMode('redirect' | 'status')` overrides the choice.

That is also why the Scalar UI shows GitHub as a **cookie** scheme with no "Authorize" button, and why the
document's `servers` entry is the relative `/`. The sign-in cannot happen inside the documentation page —
github.com refuses the browser-side token exchange, and the server would ignore the resulting bearer token
anyway, since it reads only the session cookie. Sign in at `/login/github` first; "Try it" is then same-origin
and the browser attaches the cookie on its own.

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
  -d '{"species":"DOG","name":"Buddy","ageMonths":24,"price":"150.00"}'   # 401 + location: github.com

# Ask for HTML and you get the redirect a browser would have followed:
curl -i -H 'accept: text/html' localhost:3000/users/1                     # 302 → github.com
```

The GitHub claim mapper grants every signed-in user the `write:pets` role that the pet write routes gate on.
That means **any GitHub account can write** — fine for a demo, and stated here because it is a decision rather
than an oversight. A real deployment would map the role from org or team membership.

## Local development (without Docker)

Needs a reachable PostgreSQL and `DATABASE_URL` (copy `.env.example` → `.env`).

Root `npm run build` (`tsc`) does **not** produce the `caffeine` CLI binary. Build it once
(after clone, clean, or whenever `node_modules/.bin/caffeine` is missing) before generate/build:

```sh
npm run build:cli   # bun-compile @caffeinejs/cli + link node_modules/.bin/caffeine
# or: make build:cli
```

Then:

```sh
npm run build -w @caffeinejs/example-petstore   # prisma generate + caffeine generate modules
npm run db:migrate:dev -w @caffeinejs/example-petstore   # author/apply migrations
npm run db:seed -w @caffeinejs/example-petstore
npm start -w @caffeinejs/example-petstore
```

## Out of scope / Limitations

This example deliberately covers only the parts of the spec that map cleanly onto current
caffeine capabilities. The following are **not** implemented:

- **SSE chat** (`POST /chat/completions`) — caffeine has no response-streaming/Server-Sent-Events
  helper yet.
- **Webhooks / callbacks** on orders (`callbackOrder`, `orderProcessed`) — no callback machinery.
- **Order payment** (`POST /orders/:id/payment`) — relies on polymorphic (`oneOf`/discriminator)
  payment sources that are not modelled here.
- **OAuth 2.0 device flow** and the full authorization-code/scopes matrix — auth is simplified to a
  single GitHub OAuth scheme whose claim mapper grants the `write:pets` role.
- **RFC 9457 problem+json** error bodies — this example's error handler emits `{ code, message, errors? }`
  (see `src/util/errors/`), not `application/problem+json`.
- **Rate-limit headers** (`RateLimit-*`), `x-codeSamples`, and hierarchical `tags`/`links`/tenant
  (`X-Tenant-ID`) isolation.

Notes:

- The **QUERY** verb (`@Query` decorator) requires Fastify v5's `fastify.addHttpMethod('QUERY', …)`
  in [src/app.ts](src/app.ts) before routing; without it Fastify rejects the method at registration.
  Search is served at `/pets` exactly as the spec defines it.
- Passwords are stored in clear text to keep the example small — **never** do this in production;
  hash with argon2/bcrypt.
- The Order model follows the spec's `#/components/schemas/Order` (id, petId, userId, status,
  totalAmount, currency, timestamps); `totalAmount`/`currency` default from the referenced pet when
  omitted on create.
