# `@caffeinejs/static`

Follow the root [`AGENTS.md`](../AGENTS.md) and [`http/AGENTS.md`](../http/AGENTS.md). What is load-bearing here:

- **This package serves files. It has no single-page-application feature.** There is no `.spa()`, no shell
  registry, no owned-prefix derivation and no `SPAOptions`. A SPA is routing the application writes, so its
  prefix, its `authorize` and its ordering stay with the rest of its routing. The recipes are
  [`ai/docs/spa.md`](../ai/docs/spa.md), and the scenario suite runs them. Do not grow a builder back: an
  options bag on an SPA helper regrows `index`, `exclude`, `include`, `navigationOnly` and `cache` one release
  at a time and lands back where this started.
- **Every `@fastify/static` option reaches the mount untouched.** `.serve(root, options, mount)` passes
  `options` through as given; only `root` is normalized and only `decorateReply` is decided by the plugin.
  That is the whole reason the SPA feature is gone — a wrapper owes parity with upstream forever, and this one
  had drifted to eight blocked keys and a hand-rolled send that silently dropped `preCompressed` and
  `allowedPath` for the one file that mattered. The one exception is a `list.render` under a base path: it is
  wrapped so the links it is handed carry `$basePath`, since `render` sees no request.
- **Under a base path, what `@fastify/static` sends the browser gets the base back.** It builds a redirect's
  `Location` from the URL the adapter took the base off, so a mount with `redirect: true` gets a route-level
  `onSend` — from the same flag-scoped `onRoute` hook as `anonymous` — that puts the request's `basePath` in
  front. A mount that does not redirect, or an application with no base path, gets no hook at all. The hook
  rebases `@fastify/static`'s directory redirect alone — a 301 to the request's own path with `/` added — because
  the gate's sign-in challenge passes through the same route with the base already on it. `sendFile` and
  `download` reach the same redirect from an application's route, whose hooks are fixed at registration, so they
  shadow `redirect` on that one reply instead, and only for a request that came under the base. Do not replace
  either with a server-wide hook: every route would pay for it.
- **`sendFile` / `download` delegate to the reply decorators**, never to `@fastify/send` directly. Going
  through `pumpSendToReply` is what gives a handler `preCompressed`, `allowedPath`, `setHeaders`, conditional
  requests and the `..` / non-canonical-path guards. Reimplementing is the mistake that was just undone.
- **The decorating mount is chosen, not assumed.** `@fastify/static` decorates once per server; the first
  mount that explicitly asked wins, else the first that did not decline. A `serve: false` mount registers no
  routes and exists only to decorate and to name a root — which is how a fully gated application serves its
  own bundle from compiled routes.
- **`isDocumentRequest` is a pure predicate with no options bag.** Two rules: a path naming a file is never a
  document, and — unless `navigationOnly` is off — only a browser navigation is, by `isNavigation` from
  `@caffeinejs/http`. It is for a **wildcard**; a path the application declared answers any client.
  Do not read `Sec-Fetch-*` or `Accept` anywhere else.
- **`{ anonymous: true }` on a mount** calls `exemptFromAuthentication` on its routes from an `onRoute` hook
  while that one mount registers. It fires for exactly that mount, since a mount registers every file before its
  registration resolves. It covers the **wildcard** route and the redirect as well as the per-file ones:
  `@fastify/static` gives only the per-file routes a config of their own, so reaching the rest depends on the
  adapter having stamped one first. A bundle that must be _gated_ rather than exempt is served from compiled
  routes instead — the gate can exempt a raw route but cannot give it a policy (see
  [`http/AGENTS.md`](../http/AGENTS.md)).
- **Scenario tests** (`_tests/scenarios/`) use `newRouter` chains and a `CaffeineIoC({ decorators: false })`
  container so no route leaks between the applications each file builds. `app.test.ts` is the exception and
  the reason: it builds **one** application from `@Controller` classes at module scope, and it is the test
  that keeps the recipes honest. Header sets live in `_tests/scenarios/_headers.ts` and mirror the e2e
  browser simulator's.
