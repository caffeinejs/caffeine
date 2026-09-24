# Mixing legacy and TC39 decorators

Caffeine is built on standard ECMAScript (TC39) decorators. Some libraries still ship only TypeScript's legacy
("experimental") decorators: TypeORM's `@Entity` and `@Column`, class-validator, class-transformer. This page is
how to use one of those in a Caffeine application without giving up TC39 decorators everywhere else.

**Try the decorator-free API first.** Most of these libraries have one, and it removes the whole problem — no
second compile step, no extra tooling, no exception to the TC39-only rule. TypeORM's is
[`EntitySchema`](https://typeorm.io/docs/entity/separating-entity-definition/): a row type and a schema object,
no decorators at all.

```ts
export interface Customer {
  id: string
  email: string
}

export const CustomerEntity = new EntitySchema<Customer>({
  name: 'Customer',
  tableName: 'customers',
  columns,
  relations,
})
```

`dataSource.getRepository(CustomerEntity)` returns a `Repository<Customer>` like any other. Relations name their
target by string (`target: 'Address'`), so entity modules never import each other's values.

Everything below is for a library with no such escape.

## Why the code has to be split

`experimentalDecorators` is a compiler option, so it applies to a whole TypeScript program:

- **With the flag on,** every decorator in the program compiles as a legacy decorator, including `@Controller`,
  `@Injectable` and fetchy's `@API`. Those depend on `context.metadata` and TC39 decorator contexts, and break.
- **With the flag off,** legacy decorators fail to type-check. TypeORM's `Column()` returns
  `(object, propertyName) => void`, which is not a valid TC39 field decorator. Compiled anyway, it receives
  `(undefined, context)` and throws at load.

One program cannot hold both. The legacy-decorated files need **their own TypeScript project**, and everything
else consumes only that project's **compiled output**.

## The setup

Say the legacy-decorated files are TypeORM entities, `src/**/*.entity.ts`. They stay in their feature folders;
the file suffix marks the boundary.

### 1. A TypeScript project for the legacy files

`tsconfig.entities.json`:

```jsonc
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "experimentalDecorators": true,
    // TypeORM reads `design:type` to infer column types.
    "emitDecoratorMetadata": true,
    // Legacy class-field semantics, which TypeORM assumes. With target >= ES2022 the default is `true`.
    "useDefineForClassFields": false,
    "rootDir": "src",
    "outDir": "dist/entities",
    "tsBuildInfoFile": "dist/entities.tsbuildinfo",
    "types": ["node"],
  },
  "include": ["src/**/*.entity.ts"],
}
```

A referenced project needs `composite`, `declaration` and `sourceMap`; set them here if the base config does not.
`tsc -b tsconfig.entities.json` emits `dist/entities/**/*.js` with `__decorate(…)` and
`__metadata("design:type", …)` calls, plus `.d.ts` files.

### 2. The application project excludes and references it

`tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "composite": false,
  },
  "include": ["src", "migrations", "*.ts"],
  "exclude": ["src/**/*.entity.ts", "dist"],
  "references": [{ "path": "./tsconfig.entities.json" }],
}
```

`tsc -b .` builds the legacy project, then type-checks the application against its `.d.ts` output. Editors pick
the right project per file: tsserver sees `*.entity.ts` is excluded here and finds it through the reference.

### 3. A package import as the only way in

`package.json`:

```json
{
  "imports": {
    "#entities/*": "./dist/entities/*"
  },
  "scripts": {
    "build:entities": "tsc -b tsconfig.entities.json",
    "build": "tsc -b .",
    "start": "npm run build:entities && tsx src/main.ts"
  }
}
```

Application code imports entities only through that path:

```ts
import { CustomerEntity } from '#entities/customers/customer.entity.js'
```

Node, tsx and Vite resolve `#entities/*` to the compiled JavaScript, so no TC39 transform ever sees entity
source. TypeScript resolves the same path to the emitted `.d.ts`. The legacy files import **each other**
relatively, because they share a program.

### 4. Build the legacy project before anything runs it

Every entry point needs `dist/entities` first:

- **Start and migrate scripts:** `npm run build:entities && tsx …`.
- **Tests:** a Vitest global setup runs the build. `tsc -b` is incremental, so this is cheap when nothing
  changed. Keep the TC39 transform (`unplugin-swc` with `decoratorVersion: '2022-03'`) off the compiled output:
  `exclude: ['**/node_modules/**', '**/dist/**']`.
- **Docker:** `RUN npm run build:entities` after installing dependencies.

## The one real footgun, and its guard

A **relative** import of a legacy file from application code, such as `./customer.entity.js`, type-checks.
Project references redirect it to the `.d.ts`, so `tsc` reports nothing. At run time tsx or SWC compiles the
entity source as TC39, and the service crashes at load:

```text
TypeError: Cannot read properties of undefined (reading 'constructor')
    at PrimaryGeneratedColumn.ts …
```

IDE auto-import suggests exactly that path, so a lint rule enforces the boundary. In `.oxlintrc.json`:

```json
{
  "overrides": [
    {
      "files": ["src/**/*.ts", "migrations/**/*.ts"],
      "rules": {
        "no-restricted-imports": [
          "error",
          {
            "patterns": [
              {
                "regex": "^\\.{1,2}/.*\\.entity\\.js$",
                "message": "Entities are legacy-decorated and compiled apart: import them via #entities/*, not a relative path."
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["src/**/*.entity.ts"],
      "rules": { "no-restricted-imports": ["error", { "patterns": [] }] }
    }
  ]
}
```

The second override lets the legacy files import each other relatively. An override **replaces** the rule's
options, so restate in both any patterns the root config already has.

## Runtime: the two metadata systems do not meet

- Legacy decorators with `emitDecoratorMetadata` use `Reflect.metadata` / `Reflect.getMetadata`, from
  `reflect-metadata`. TypeORM loads it itself, so the application never imports it.
- Caffeine and fetchy store their metadata in `Symbol.metadata`, and never read `Reflect.*`.

Once compiled, both are plain JavaScript and coexist in one process with no interaction.

## Pitfalls

- **Circular entity imports.** With `emitDecoratorMetadata`, a relation field typed as the other entity class
  emits `__metadata("design:type", OtherEntity)`. While the two modules import each other that class is still in
  its temporal dead zone, and loading throws `ReferenceError`. Type relations as TypeORM's `Relation<T>`, which
  emits `Object`.
- **`useDefineForClassFields`.** Leave it `false` in the legacy project. Define semantics create own properties
  that shadow what legacy libraries expect on the prototype.
- **Caffeine's rules still apply outside that project.** Keep the exception confined to the legacy `tsconfig`,
  and say so where someone will read it.

`caffeine generate modules` needs nothing: it provides a class only when one of its decorators resolves to the
Caffeine package that exports it, so `@Entity` and fetchy's `@API` are ignored without an `exclude`.

## Checking that it works

- Build the legacy project and look at the output: `dist/entities/**/*.js` should contain `__decorate([...])`
  and `__metadata("design:type", …)`.
- Build a TypeORM `DataSource` over the imported entities and read `dataSource.getMetadata(Entity).columns`. The
  column names and types, and relation options such as `onDelete`, should match the decorators.
- Replace one `#entities/…` import with a relative one. `tsc` still passes, the app crashes at load, and oxlint
  reports the import. All three confirm the guard is needed and works.
