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
  which it never answers so that a client is not taken for a promise, and at the root `$request` and the
  `FileHelpers` names (`files.ts`), which `BrewClient` passes to `Node` as reserved. Hiding more would hide segments
  the proxy can reach.
- `BodyArg` (`init.ts`) reads an upload the way `hasFileSchema` (`application/schema/t.ts`) does: the body itself,
  or one level of its properties, each a file or a list of files and nothing else, so a union holding one is no
  upload, and a union body is JSON whatever its members hold. Change them together.
- `send()` builds a `Request` only for a client with interceptors or an authenticator; without either it hands the
  transport `(url, init)`, as a custom `fetch` and the transport tests expect. Every call builds its own, so nothing
  set on one reaches another.
- The authenticator's copy is `new Request(sent, { headers, body })`, its body extracted anew from what the call gave,
  never `request.clone()`: a clone tees the body into memory, opens a function body early, and in Node 22 drops an
  undici `dispatcher`. A `FormData` copy drops `content-type`, so the platform writes the new boundary.
- Nothing outlives a call: no module-level `WeakSet`, `WeakMap` or other state shared across calls. A call decides
  from what it holds, such as a response's `url` and `redirected`, which a `clone()` keeps; constant lookup tables
  (`RAW_BODIES`) are not state.
- `discard()` cancels every body it is given at once: a body and its `clone()` share a tee, which settles the cancel
  of one only once the other is cancelled too, so cancelling them in turn never returns.
