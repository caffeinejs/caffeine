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
