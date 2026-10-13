# `@caffeinejs/devtools`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- DevTools is a plugin factory that mounts one router through `context.app` and installs nothing on the server: no
  feature, no container hooks, no Fastify. A slice reads the initialized container, the configuration store or the
  route table when a request arrives, and resolves what it needs while building its router, so a misconfiguration
  fails at start-up.
- The plugin owns every group's path, name, authorization, `cache-control: no-store`, JSON content type and
  `detail('http', { internal: true })`, declared on the router every slice is nested in. A slice declares none of
  them.
- A slice returns a router bound to no adapter, `new Router()`, so DevTools stays free of any one server library.
- Call `authorize(...)` on a group only for what was declared: routing reads any declaration, an empty one
  included, as protection.
- `wire.ts` is the contract `@caffeinejs/devtools-ui` reads. Change it together with that package.
- Never send a configuration value without `showValues()`, a value whose path is masked, or an indicator's `data`.
- The text of a key, a scope, a name or a label comes from the binding graph's nodes, so `bindings` and `graph`
  agree. Do not format keys here.
