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
- Guards are split the same way. `framework/guards/` holds only what every kind of application shares: the chain
  runner (`runGuards`), the key compiler (`compileGuardKeys`), `ErrGuardConfiguration`, and the two shapes a
  transport builds on, `BaseGuard<I>` and `GuardOutcome`. A transport owns everything its users touch: its own
  `Guard extends BaseGuard<Input>`, an `Input` carrying a literal `kind`, its own `GuardResult` / `GuardReturn` /
  `GuardTarget`, the `GuardDenial` mapping a denial to its statuses, and how guards attach. Do not add a
  `GuardResult` or a user-facing `Guard` here: the transport's is the one import path its users have.
