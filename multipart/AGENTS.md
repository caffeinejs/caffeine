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

## The options bag goes through the configuration

`.options({ ... })` does not hold the bag on the builder: it writes it into the feature's config slice in the
`CODE` band, so a value set in code is a **default** that a file, `MULTIPART__OPTIONS__*`, or a command-line
argument overrides. `multipartConfigSchema` is exported so an application can splice it into its own schema and
point the feature at that location with `.config(c => c.app.multipart)`.

The bag is a `Record` in the schema, not a declared mirror of `@fastify/multipart`'s options: the validator strips
every property a schema does not name, so a partial mirror would silently drop the rest. Callbacks are split
out with `splitOptionBag(...)` and merged back after the slice publishes — a function cannot travel through a
configuration tree.
