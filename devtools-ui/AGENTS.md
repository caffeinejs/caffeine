# `@caffeinejs/devtools-ui`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- The UI talks to an application only through its DevTools endpoints, with fetchy. It imports `@caffeinejs/devtools`
  with `import type` alone: the wire types are the contract, and nothing of that package runs here.
- A fetchy client is one `@API` class per slice, with no base class. Its operations are decorated public fields
  with `!` (`get!: () => Promise<T>`), never methods, as `fetchy/fetchy/AGENTS.md` asks. The interceptors in
  `interceptors.ts` are shared by every client.
- Everything a target sends is untrusted: render it with `safe`, build an href only from an id the index listed and
  only with `encodeURIComponent`, and never follow an href a target sent.
- No client JavaScript and no inline style: the content security policy refuses both.
- Routes are programmatic routers, so the Vitest config can run decorator version 2023-11, which fetchy needs, and
  meets no HTTP decorator. Never alias `@caffeinejs/http` or `@caffeinejs/html` to source there either: two copies of
  `Responder` make a page come back as JSON.
- A slice with no page of its own renders on the generic page, so a new core slice shows up with no change here.
