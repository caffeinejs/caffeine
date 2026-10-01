# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- `index.ts` exports only the root-level modules: `application`, `configuration`, `feature`, `feature_builder`.
- Each sub-directory (`duration/`, `schema/`, `shutdown/`, …) is its own `package.json` `exports` subpath and is
  never re-exported from `index.ts`; outside `std/`, import it as `@caffeinejs/std/<sub>`.
- A feature's configuration schema is `<sub>/schema.ts` (`logger/schema.ts`, `shutdown/schema.ts`) and is internal:
  no `exports` subpath, never re-exported from `<sub>/index.ts`. `schema/` is the `$t` dialect, not a configuration
  schema.
- Each config source, `config/sources/<name>/`, is its own `exports` subpath, `@caffeinejs/std/config/<name>`, and
  is never re-exported from `config/index.ts`. Its `index.ts` names the public surface; code in `std` reaches a
  helper it leaves out, such as `parseArgv`, through the module file.
- Health indicators reach `ApplicationHealth` only as container beans bound with `.extends(HealthIndicator)`; do
  not add a registration API beside that.
- Nothing in `health/` knows about HTTP: rendering and routes stay in `http/health/`.
- `framework/guards/` holds only what every kind of application shares: `runGuards`, `compileGuardKeys`,
  `ErrGuardConfiguration`, `BaseGuard<I>` and `GuardOutcome`.
- A transport owns its own `Guard`, `GuardResult` / `GuardReturn` / `GuardTarget` and `GuardDenial`; do not add a
  `GuardResult` or a user-facing `Guard` here.
