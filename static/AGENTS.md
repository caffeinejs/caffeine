# `@caffeinejs/static`

Follow the root [`AGENTS.md`](../AGENTS.md) and [`http/AGENTS.md`](../http/AGENTS.md), plus:

- No single-page-application feature: no `.spa()`, no shell registry, no owned-prefix derivation and no
  `SPAOptions`. A SPA is routing the application writes; the recipes are [`ai/docs/spa.md`](../ai/docs/spa.md).
- Every `@fastify/static` option reaches the mount untouched: `.serve(root, options, mount)` passes `options`
  through as given; only `root` is normalized and only `decorateReply` is decided by the plugin. The one exception
  is a `list.render` under a base path, which is wrapped so the links it is handed carry `$basePath`.
- Under a base path, a mount with `redirect: true` gets a route-level `onSend` that puts the request's `basePath` in
  front of `@fastify/static`'s directory redirect; `sendFile` and `download` shadow `redirect` on that one reply
  instead. Do not replace either with a server-wide hook: every route would pay for it.
- `sendFile` / `download` delegate to the reply decorators, never to `@fastify/send` directly. `pumpSendToReply` is
  what gives a handler `preCompressed`, `allowedPath`, `setHeaders`, conditional requests and the path guards.
- `isDocumentRequest` is a pure predicate with no options bag: a path naming a file is never a document, and —
  unless `navigationOnly` is off — only a browser navigation is, by `isNavigation` from `@caffeinejs/http`. It is
  for a wildcard.
- `{ anonymous: true }` on a mount calls `exemptFromAuthentication` on its routes from an `onRoute` hook while that
  one mount registers. A bundle that must be gated rather than exempt is served from compiled routes; see
  [`http/AGENTS.md`](../http/AGENTS.md).
- Scenario tests (`_tests/scenarios/`) use `newRouter` chains and a `CaffeineIoC({ decorators: false })` container
  so no route leaks between the applications each file builds. `_tests/scenarios/app.test.ts` is the exception: it
  builds one application from `@Controller` classes at module scope. Header sets live in
  `_tests/scenarios/_headers.ts` and mirror the e2e browser simulator's.
