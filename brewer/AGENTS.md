# `@caffeinejs/brewer`

The typed client. **Zero runtime dependencies, and it must stay that way** — it runs in a browser, so no Node imports and nothing beyond `fetch`, `URL`, `URLSearchParams` and `Proxy`. `@caffeinejs/http` is a devDependency used only by tests that stand a real server up; never import it from source.

`RouteContract` is a structural copy of `@caffeinejs/http`'s `RouteDef`, deliberately not an import — that is what keeps this package free of http. The copy is guarded by a type test asserting `RouteDef` satisfies `RouteContract`; if you change one, change both.

`Fetchable` is structural for the same reason: `brewer(app)` takes an application without this package knowing what one is. Its parameter list is `globalThis.fetch`'s, which is also `WebApplication.fetch`'s, so the method drops into the `fetch` option unchanged — keep it that way rather than narrowing it. A target only ever decides which `fetch` is called; `send` and the proxy do not know a target exists.

`brewer` has three overloads and the order is load-bearing. The URL one comes first; the inferring one (`T extends Fetchable`) is what makes the bare `brewer(app)` read its routes off the argument; the third (`T` unconstrained, target `Fetchable`) is what makes `brewer<typeof someRouter>(app)` resolve, since a `Router` is not `Fetchable` and would fail the second one's constraint. Removing it silently breaks typing a client from one router while driving it through the application.

The types are the package. `tree.ts` turns the flat route union into the proxy's node tree, and it is the part that gets expensive on a large API — keep the conditional types shallow, and do not add a second traversal where an existing one can carry the answer.
