# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- No dependencies of any kind, and no import of another workspace package: a package that needs only a duration, a
  byte size or the error message builder installs nothing else. The application framework is
  `@caffeinejs/application`, which depends on this package, never the other way round.
- There is no root entry. Each sub-directory (`duration/`, `bytes/`, `err/`) is its own `package.json` `exports`
  subpath; import it as `@caffeinejs/std/<sub>`.
- `formatDuration` is Go's `String()` with days. `DURATION_PATTERN` admits exactly the unsigned text the parser reads,
  which `duration.prop.test.ts` checks, so change the two together, with the tables in `duration.test.ts`.
- `formatBytes` writes the largest exact unit. `BYTES_PATTERN` admits exactly the text the parser reads, except past
  `Number.MAX_SAFE_INTEGER` bytes, which `bytes.prop.test.ts` checks, so change the two together, with the tables in
  `bytes.test.ts`.
- An error class extends `Error` directly: `ErrCaffeine` belongs to `@caffeinejs/application`.
- The reference line of `errMessage` is printed only once `REFERENCE_BASE_URL` in `err/message.ts` is set.
