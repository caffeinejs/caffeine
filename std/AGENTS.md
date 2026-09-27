# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- `index.ts` exports only the root-level modules: `application`, `configuration`, `feature`, `feature_builder`.
- Each sub-directory (`duration/`, `schema/`, `shutdown/`, …) is its own `package.json` `exports` subpath and is
  never re-exported from `index.ts`; outside `std/`, import it as `@caffeinejs/std/<sub>`.
- Health indicators reach `ApplicationHealth` only as container beans bound with `.extends(HealthIndicator)`; do
  not add a registration API beside that.
- Nothing in `health/` knows about HTTP: rendering and routes stay in `http/health/`.
- `framework/guards/` holds only what every kind of application shares: `runGuards`, `compileGuardKeys`,
  `ErrGuardConfiguration`, `BaseGuard<I>` and `GuardOutcome`.
- A transport owns its own `Guard`, `GuardResult` / `GuardReturn` / `GuardTarget` and `GuardDenial`; do not add a
  `GuardResult` or a user-facing `Guard` here.
