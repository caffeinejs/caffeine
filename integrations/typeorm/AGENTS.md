# `@caffeinejs/typeorm`

Follow the root [`AGENTS.md`](../../AGENTS.md), plus:

- `dataSource(options)` takes `DataSourceOptions` whole, entities included. Do not add an `entities(...)` method or a
  per-setting fluent method.
- `config(options)` fills in what `dataSource(...)` left out. `TypeORMConfigSchema` (`schema.ts`, internal) carries
  only the connection settings a deployment tunes; the driver `type` and the entities stay in code.
- `registerStage(kRepositoryStage, …)` runs at module scope in `injection.ts`, beside `$repository`, and
  `package.json` `"sideEffects"` names `./dist/injection.js`. Do not move the registration to `index.ts`, which is
  not on the allowlist, and do not export the stage or the symbol naming it.
- In `$repository(Entity, dataSource)`, a string is an instance name folded through `dataSourceKey(name)` — the
  same name `TypeORM('reports', ...)` was installed under — and anything else is a `NamedToken<DataSource>`. The
  parameter does not accept a bare `symbol`, and a self-provided DataSource is bound under a symbol token.
- `repositoryStage` chooses the binding and throws `ErrNoDataSource` / `ErrNoUniqueDataSource` while the container
  compiles; only `getRepository` runs per resolution. Do not move a check into the returned thunk — see
  [`di/AGENTS.md`](../../di/AGENTS.md).
- The unnamed instance owns `DataSource`; a named instance answers to `dataSourceKey(name)` alone, so a second
  instance never makes `DataSource` ambiguous.
- The `DataSource` binding is `toAsyncFactory`, so `init()` awaits `initialize()` before `bootstrap()` returns. The
  container rejects `lazy` on an async binding, so do not add a `lazy` knob.
- Tests and examples use `EntitySchema`, not `@Entity` / `@Column`.
