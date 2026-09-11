# `@caffeinejs/multipart`

Follow the root [`AGENTS.md`](../AGENTS.md).

Two public spellings, one implementation. The readers live in [`_parts.ts`](_parts.ts) over the Fastify request;
[`pickers.ts`](pickers.ts) wraps them as `$multipart.*` for a decorated handler's arguments, and
[`helpers.ts`](helpers.ts) wraps them as `multipart(ctx).*` for a handler that receives only the context — every
programmatic route, since the router owns those routes' parameters. A new reader goes in `_parts.ts` and is
exposed through both; never write a second copy.

An upload route documents itself either way: a decorated one through the picker types the OpenAPI generator
reads, a context one through a `$t.File()` body schema. That schema slot is not validated — the parts are
streamed, so `request.body` is never populated.

## The package is a plugin, not a feature

There is no builder and no `Feature` here: the package exports `multipartPlugin(options)` alongside the
readers. An application registers it with the plugin factory `.extend(...)` takes, reading whatever it wants out
of the configuration on the way:

```ts
.extend(c => multipartPlugin(c.app.multipart.options))
```

`multipartConfigSchema` is exported so an application can splice it into its own schema rather than restate the
fields. The bag is a `Record` there, not a declared mirror of `@fastify/multipart`'s options: the validator strips every
property a schema does not name, so a partial mirror would silently drop the rest.

A callback option needs no special handling — the bag never travels through a configuration tree, so it is
written where the plugin is registered and handed over as-is.
