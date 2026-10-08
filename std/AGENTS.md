# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- `index.ts` exports only the root-level modules: `application`, `configuration`, `feature`, `feature_builder`.
- Each sub-directory (`duration/`, `schema/`, `shutdown/`, …) is its own `package.json` `exports` subpath and is
  never re-exported from `index.ts`; outside `std/`, import it as `@caffeinejs/std/<sub>`.
- The logger's and the shutdown policy's configuration schemas are in `_spectypes/` (`logger.ts`, `shutdown.ts`),
  internal: no `exports` subpath, never re-exported. `schema/` is the `$t` dialect, not a configuration schema.
- Each config source, `config/sources/<name>/`, is its own `exports` subpath, `@caffeinejs/std/config/<name>`, and
  is never re-exported from `config/index.ts`. Its `index.ts` names the public surface; code in `std` reaches a
  helper it leaves out, such as `parseArgv`, through the module file.
- Health indicators reach `ApplicationHealth` only as container beans bound with `.extends(HealthIndicator)`; do
  not add a registration API beside that.
- Nothing in `health/` knows about HTTP: rendering and routes stay in `http/health/`.
- `framework/guards/` holds only what every kind of application shares: `runGuards`, `compileGuardKeys`,
  `ErrGuardConfiguration`, `BaseGuard<I>` and `GuardOutcome`.
- `framework/err/message.ts` is the error message builder (`errMessage`), and the only place it is written. It
  imports nothing: the packages in `tools/copy-err-message.json` cannot depend on `std` and get a generated copy,
  which `make err-message` writes. The reference line is printed only once `REFERENCE_BASE_URL` is set here.
- `framework/err/` is its own `exports` subpath, `@caffeinejs/std/framework/err`, and is never re-exported from
  `framework/index.ts`: that barrel loads `di` through the guards, and a package that needs only the builder must not.
- A transport owns its own `Guard`, `GuardResult` / `GuardReturn` / `GuardTarget` and `GuardDenial`; do not add a
  `GuardResult` or a user-facing `Guard` here.
