# `@caffeinejs/typeorm`

Follow the root [`AGENTS.md`](../../AGENTS.md). The rules below are specific to this package.

## The builder does not restate TypeORM's configuration

`dataSource(options)` takes `DataSourceOptions` whole. There is no config slice, no exported schema and no
per-setting fluent method, so a driver option this package has never heard of still works and a TypeORM
upgrade needs no change here. Entities travel in those options — do not add an `entities(...)` method.

Configuration reaches the feature only through the application's configure callback, which reads the
application's own schema. This package publishes no configuration key and declares no slice.

## The stage is registered where `$typeorm` is defined

`registerStage(kRepositoryStage, …)` runs at module scope in `injection.ts`, beside the only export that uses
it, and `package.json` `"sideEffects"` names `./dist/injection.js`. Both matter: the registration is a live
use of an exported binding _and_ is on the allowlist, so no bundler can drop it. Moving the registration to
`index.ts` would break that — the barrel is not on the allowlist.

The stage and the symbol naming it are module-private. Nothing outside `injection.ts` needs either, and
`index.ts` does not re-export them.

## A string names an instance; a symbol is a key

`$typeorm.repository(Entity, 'reports')` folds through `dataSourceKey('reports')`, so the string is the same
name `typeorm('reports', ...)` was installed under — one name, written the same way on both sides. Anything
else has to be a `NamedToken<DataSource>`, which is what lets a DataSource the application provided itself be
selected by its own token.

A _string_ token cannot be told from an instance name at run time, so it is always read as a name. That is why
a self-provided DataSource is bound under a symbol token, and why the parameter does not accept a bare
`symbol`: an unbranded one carries no promise about what it resolves to.

## Everything resolvable is decided at compile time

`repositoryStage` chooses the binding, and throws `ErrNoDataSource` / `ErrNoUniqueDataSource`, while the
container compiles. Only `getRepository` runs per resolution, and the provider it reads is built once. A
check moved into the returned thunk would turn a start-up failure into a per-request one and add work to the
hot path — see the performance rules in [`di/AGENTS.md`](../../di/AGENTS.md).

## The unnamed instance owns `DataSource`; a named one owns its key alone

Binding a named instance under TypeORM's class as well would make `DataSource` ambiguous the moment a second
one is installed. `dataSourceKey(name)` is the only key a named instance answers to.

## The DataSource binding is async, and cannot be lazy

`toAsyncFactory` is what makes `init()` await `initialize()` before any binding that injects a repository
resolves, so the connection is open by the time `ready()` returns. The container rejects `lazy` on an async
binding, and a `bootstrap` hook would force-resolve a lazy binding anyway — so "lazy" and "connected before
`ready()`" cannot both hold. Do not add a `lazy` knob without resolving that first.

## Entities are `EntitySchema`

TypeORM's `@Entity` / `@Column` are legacy decorators and cannot compile in this repository. Tests and
examples use `EntitySchema`. Never add `experimentalDecorators` here.
