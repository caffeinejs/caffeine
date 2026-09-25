# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- The root barrel (`index.ts`) exports only the root-level modules: `application`, `configuration`, `feature`,
  `feature_builder`. Each sub-directory (`duration/`, `schema/`, `shutdown/`, …) is its own `package.json`
  `exports` subpath and is never re-exported from `index.ts`. Outside `std/`, import it as
  `@caffeinejs/std/<sub>`.
