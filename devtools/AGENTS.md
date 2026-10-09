# `@caffeinejs/devtools`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- DevTools is a plugin and nothing else: no feature, no container hooks. A slice reads the initialized container,
  the configuration store or the route table when a request arrives, and resolves what it needs while building
  its routes, so a misconfiguration fails at start-up.
- The plugin owns every group's path, authorization, `cache-control: no-store`, JSON content type and
  `detail('http', { internal: true })`. A slice declares none of them, and nothing lets one loosen them.
- Call `authorize(...)` on a group only for what was declared: routing reads any declaration, an empty one
  included, as protection.
- `wire.ts` is the contract `@caffeinejs/devtools-ui` reads. Change it together with that package.
- Never send a configuration value without `showValues()`, a value whose path is masked, or an indicator's `data`.
- The text of a key, a scope, a name or a label comes from the binding graph's nodes, so `bindings` and `graph`
  agree. Do not format keys here.
