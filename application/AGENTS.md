# `@caffeinejs/application`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- `index.ts` exports only the root-level modules: `application`, `configuration`, `feature`, `feature_builder`.
- Each sub-directory (`config/`, `schema/`, `shutdown/`, …) is its own `package.json` `exports` subpath and is never
  re-exported from `index.ts`; outside `application/`, import it as `@caffeinejs/application/<sub>`.
- `ErrCaffeine` (`error.ts`) is the base of every error class here, and is internal: no `exports` subpath and no
  barrel reaches it.
- The logger's and the shutdown policy's configuration schemas are in `_spectypes/` (`logger.ts`, `shutdown.ts`).
  `schema/` is the `$t` dialect, not a configuration schema.
- Each config source, `config/sources/<name>/`, is its own `exports` subpath, `@caffeinejs/application/config/<name>`,
  and is never re-exported from `config/index.ts`. Its `index.ts` names the public surface; code in `application`
  reaches a helper it leaves out, such as `parseArgv`, through the module file.
- Health indicators reach `ApplicationHealth` only as container beans bound with `.extends(HealthIndicator)`; do
  not add a registration API beside that.
- Nothing in `health/` knows about HTTP: rendering stays in `http/core/health/`, routes in
  `http/platform/fastify/health/`.
- `framework/guards/` holds only what every kind of application shares: `runGuards`, `compileGuardKeys`,
  `ErrGuardConfiguration`, `BaseGuard<I>` and `GuardOutcome`.
- A transport owns its own `Guard`, `GuardResult` / `GuardReturn` / `GuardTarget` and `GuardDenial`; do not add a
  `GuardResult` or a user-facing `Guard` here.
