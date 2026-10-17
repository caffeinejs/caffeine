# `@caffeinejs/brewer`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- Zero runtime dependencies, and it must stay that way: no Node imports and nothing beyond `fetch` and the classes it
  works with (`Headers`, `FormData`, `Blob`, `File`, web streams), `URL`, `URLSearchParams` and `Proxy`, because it
  runs in a browser. `@caffeinejs/http` is a devDependency for tests
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
- `StaticChildren` hides exactly the names the proxy answers itself: a verb (`Verb`, the runtime's list), `then`,
  which it never answers so that a client is not taken for a promise, and `$request` at the root, which `BrewClient`
  passes to `Node` as reserved. Hiding more would hide segments the proxy can reach.
- `BodyArg` (`init.ts`) reads an upload the way `hasFileSchema` (`std/schema/t.ts`) does: the body itself, or one
  level of its properties, each a file or a list of files and nothing else, so a union holding one is no upload.
  Change them together.
