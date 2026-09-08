# `@caffeinejs/cors`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## The options bag goes through the configuration

`.options({ ... })` does not hold the bag on the builder: it writes it into the feature's config slice in the
`CODE` band, so a value set in code is a **default** that a file, `CORS__OPTIONS__*`, or a command-line
argument overrides. `corsConfigSchema` is exported so an application can splice it into its own schema and
point the feature at that location with `.config(c => c.app.cors)`.

The bag is a `Record` in the schema, not a declared mirror of `@fastify/cors`'s options: the validator strips
every property a schema does not name, so a partial mirror would silently drop the rest. Callbacks are split
out with `splitOptionBag(...)` and merged back after the slice publishes — a function cannot travel through a
configuration tree.
