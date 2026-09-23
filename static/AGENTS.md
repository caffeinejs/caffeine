# `@caffeinejs/static`

Follow the root [`AGENTS.md`](../AGENTS.md) and [`http/AGENTS.md`](../http/AGENTS.md). What is load-bearing here:

- **The shell is a compiled route, not a not-found handler.** `.spa(root)` registers `GET <prefix>/*` (and
  `GET <prefix>` for a prefixed shell) through `instance.$route`, marked `detail('http', { internal: true })` so
  `@caffeinejs/openapi` does not describe it. It is authorized like any route through `authorize`, public by
  default, and a request it refuses throws `ErrHTTPNotFound` into the ordinary error pipeline. The adapter's
  default not-found handler, and any the application set, are untouched. Do not reach for `setNotFoundHandler`.
- **The shell document is sent with `@fastify/send`**, never through `reply.sendFile`: which mount decorated
  the reply is nobody's business, and `GET /`, `GET /index.html` and `GET /settings` all carry the same headers.
  `@fastify/static` serves the shell's files with `wildcard: false`, `index: false`, `decorateReply: false` and
  the shell document ignored; its default `GET /*` would collide with the route.
- **Owned prefixes come from `collectRouteGroups` alone**, derived once in `onReady` by `_owned.ts`. Raw
  Fastify routes declare nothing and need nothing: an exact URL that matched a route never reaches the shell.
  Groups marked `http.internal` own no prefix.
- **Assets follow the shell.** The file routes of a shell with `allowAnonymous` are marked
  `kAuthenticationExempt` from an `onRoute` hook while that one mount registers. A gated shell's files fall under
  the application's fallback policy like any raw route.
- **Navigation is `isNavigation` from `@caffeinejs/http`**, the same rule a scheme redirects on. Do not
  reintroduce a local reading of `Sec-Fetch-*` or `Accept`.
- **Several shells per origin** are one `.spa()` call per prefix; the longest prefix wins by routing.
  `ErrDuplicateSPAMount` is for two shells at one prefix only.
- **Scenario tests** (`_tests/scenarios/`) use `newRouter` chains and a `CaffeineIoC({ decorators: false })`
  container, never a `@Controller`, so no route leaks between applications built in one file. Header sets live
  in `_tests/scenarios/_headers.ts` and mirror the e2e browser simulator's.
