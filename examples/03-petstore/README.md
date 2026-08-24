# 03 — Petstore (caffeine + Prisma/PostgreSQL)

A CaffeineJS HTTP app modelled on the **Modern Petstore OpenAPI 3.2** spec
([spec/openapi.petstore.yaml](./spec/openapi.petstore.yaml)). It exercises more of
`@caffeinejs/http` than the earlier examples:

- **Persistence** via **Prisma Client** over **PostgreSQL** (no in-memory store).
- **Two layers only**: `controller → repository`. Repositories own every query and the
  row → API-DTO mapping; controllers own routing, validation, and status codes.
- **Request/response validation** with `@Schema`, declared in the `$t` dialect from `@caffeinejs/std` and mirroring the spec. A `$t` schema is JSON Schema, so it compiles straight into a Fastify Ajv validator and carries the TypeScript type with it.
- **Auth**: JWT bearer (`@caffeinejs/http` `addJWTBearer`) with `@Authorize({ roles })` gating writes.
- **Multipart upload** (`$p.file()`), and the OpenAPI 3.2 **QUERY** search verb.
- **Kubernetes probes + graceful shutdown** via `.health()`: `/livez`, `/readyz`, `/startupz`, a database readiness indicator, and a drain that refuses readiness before it stops listening.
- **Dockerised**: `docker-compose` brings up Postgres + the app, runs migrations, seeds demo data.

## Architecture

```
src/main.ts                  bootstrap: builds the app, supplies the database health indicator
src/app.ts                   features: QUERY verb, @fastify/multipart, JWT bearer, GitHub OAuth, health probes
src/features/health/db.health.ts  HealthIndicator — readiness only, never liveness
src/internal/db/prisma.ts    single PrismaClient handle
src/internal/db/prisma.config.ts  @Configuration + @Provides(PrismaClient) — DI registration
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

## Endpoints → spec operations

| Method | Path                 | operationId       | Auth                    |
| ------ | -------------------- | ----------------- | ----------------------- |
| GET    | `/pets`              | listPets          | public                  |
| QUERY  | `/pets`              | searchPets        | public                  |
| GET    | `/pets/:id`          | getPet            | public                  |
| POST   | `/pets`              | createPet         | `write:pets`            |
| PUT    | `/pets/:id`          | updatePet         | `write:pets`            |
| DELETE | `/pets/:id`          | deletePet         | `write:pets`            |
| POST   | `/pets/:id/images`   | uploadPetPhoto    | `write:pets` (multipart)|
| POST   | `/orders`            | createOrder       | public                  |
| GET    | `/orders/:id`        | getOrder          | public                  |
| DELETE | `/orders/:id`        | deleteOrder       | public                  |
| POST   | `/users`             | createUser        | public                  |
| GET    | `/users/:id`         | getUserById       | public                  |
| PUT    | `/users/:id`         | updateUser        | public                  |
| DELETE | `/users/:id`         | deleteUser        | public                  |
| GET    | `/inventories`       | getInventory      | public                  |
| POST   | `/auth/tokens`       | createToken       | public                  |

## Auth flow

```sh
# 1. Log in → JWT (the demo grants the write:pets scope)
TOKEN=$(curl -s localhost:3000/auth/tokens \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"wonderland"}' | jq -r .token)

# 2. Public read
curl localhost:3000/pets

# 3. Guarded write — 401 without the token, 201 with it
curl -X POST localhost:3000/pets -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"species":"DOG","name":"Buddy","ageMonths":24,"price":"150.00"}'

# 4. QUERY search
curl -X QUERY localhost:3000/pets -H 'content-type: application/json' \
  -d '{"criteria":{"species":["DOG"],"ageRange":{"min":12,"max":72}}}'
```

## Local development (without Docker)

Needs a reachable PostgreSQL and `DATABASE_URL` (copy `.env.example` → `.env`).

```sh
npm run build -w @caffeinejs/example-petstore   # prisma generate + caffeine generate
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
  single JWT bearer scheme; the login endpoint mints a token with the `write:pets` scope.
- **RFC 9457 problem+json** error bodies — caffeine's error handler emits `{ message, statusCode }`,
  not `application/problem+json`.
- **Rate-limit headers** (`RateLimit-*`), `x-codeSamples`, and hierarchical `tags`/`links`/tenant
  (`X-Tenant-ID`) isolation.

Notes:

- The **QUERY** verb (`@Query` decorator) requires Fastify v5's `fastify.addHttpMethod('QUERY', …)`
  in [src/main.ts](src/main.ts) before routing; without it Fastify rejects the method at registration.
  Search is served at `/pets` exactly as the spec defines it.
- Passwords are stored in clear text to keep the example small — **never** do this in production;
  hash with argon2/bcrypt.
- The Order model follows the spec's `#/components/schemas/Order` (id, petId, userId, status,
  totalAmount, currency, timestamps); `totalAmount`/`currency` default from the referenced pet when
  omitted on create.
