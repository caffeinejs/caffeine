# `@caffeinejs/cors`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## The package is a plugin, not a feature

There is no builder and no `Feature` here: the package exports `corsPlugin(options)` and the route-extension
half. An application registers it with the plugin factory `.extend(...)` takes, reading whatever it wants out
of the configuration on the way:

```ts
.extend(c => corsPlugin(c.app.cors.options))
```

`corsConfigSchema` is exported so an application can splice it into its own schema rather than restate the
fields. The bag is a `Record` there, not a declared mirror of `@fastify/cors`'s options: the validator strips every
property a schema does not name, so a partial mirror would silently drop the rest.

A callback option needs no special handling — the bag never travels through a configuration tree, so it is
written where the plugin is registered and handed over as-is.
