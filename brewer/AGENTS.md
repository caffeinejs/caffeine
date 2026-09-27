# `@caffeinejs/brewer`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- Zero runtime dependencies, and it must stay that way: no Node imports and nothing beyond `fetch`, `URL`,
  `URLSearchParams` and `Proxy`, because it runs in a browser. `@caffeinejs/http` is a devDependency for tests
  only; never import it from source.
- `RouteContract` is a structural copy of `@caffeinejs/http`'s `RouteDef`, deliberately not an import. A type
  test guards the copy; if you change one, change both.
- `Fetchable` takes `globalThis.fetch`'s parameter list; do not narrow it.
- `brewer` has three overloads and the order is load-bearing; the third (`T` unconstrained, target `Fetchable`)
  is what makes `brewer<typeof someRouter>(app)` resolve.
- Keep the conditional types in `tree.ts` shallow, and do not add a second traversal where an existing one can
  carry the answer.
- The open member of `BrewResponseOf` stays `BrewResponse<never>`: give it a body and every declared member stops
  narrowing. A wildcard response key (`'4xx'`, `'5xx'`, `'default'`) is not read.
- Do not widen the `Verb` exclusion in `StaticChildren`; `Verb` is the runtime's list, and hiding more would hide
  segments the proxy can reach.
