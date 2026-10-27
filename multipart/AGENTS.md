# `@caffeinejs/multipart`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- A new reader goes in `_parts.ts` and is exposed through both spellings, `$multipart.*` in `pickers.ts` and
  `formData(ctx).*` in `helpers.ts`; never write a second copy.
- The `$t.File()` body schema slot is not validated, because the parts are streamed and `request.body` is never
  populated.
- The package is a plugin, not a feature: there is no builder and no `Feature`, only the `multipart()` plugin factory.
- `MultipartOptions` (`multipart_plugin.ts`) is derived structurally from `@fastify/multipart`'s plugin
  signature, not restated.
