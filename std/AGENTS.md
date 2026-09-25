# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- The root barrel (`index.ts`) exports only the root-level modules: `application`, `configuration`, `feature`,
  `feature_builder`. Each sub-directory (`duration/`, `schema/`, `shutdown/`, …) is its own `package.json`
  `exports` subpath and is never re-exported from `index.ts`. Outside `std/`, import it as
  `@caffeinejs/std/<sub>`.
- Health is always there. `Application.ready()` binds `ApplicationHealth` (`health/`) next to
  `ApplicationAvailability`, lazily and as a singleton, for every application kind. `app.health` reads that binding
  and holds no instance of its own. Indicators reach it only as container beans bound with
  `.extends(HealthIndicator)` — do not add a registration API beside that. Its budgets
  are whatever `kHealthRegistryOptions` holds, which `health()` from `@caffeinejs/http` binds, else
  `defaultHealthRegistryOptions()`. Nothing here knows about HTTP: rendering and routes stay in `http/health/`.
