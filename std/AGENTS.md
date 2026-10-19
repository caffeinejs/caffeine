# `@caffeinejs/std`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- No dependencies of any kind, and no import of another workspace package: a package that needs only a duration, a
  byte size or the error message builder installs nothing else. The application framework is
  `@caffeinejs/application`, which depends on this package, never the other way round.
- There is no root entry. Each sub-directory (`duration/`, `bytes/`, `err/`) is its own `package.json` `exports`
  subpath; import it as `@caffeinejs/std/<sub>`.
- An error class extends `Error` directly and sets its own `name` and `code`: `ErrCaffeine` belongs to
  `@caffeinejs/application`.
- `err/message.ts` is the error message builder (`errMessage`), and the only place it is written. It imports nothing:
  the packages in `tools/copy-err-message.json` do not depend on `std` and get a generated copy, which
  `make err-message` writes. The reference line is printed only once `REFERENCE_BASE_URL` is set here.
