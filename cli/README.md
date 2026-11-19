# @caffeinejs/cli

The `caffeine` command of CaffeineJS: it scaffolds a new application and generates the code an application builds
from, such as its module graph. It also builds and verifies static release directories.

```sh
npm install -E -D @caffeinejs/cli
```

```sh
npx @caffeinejs/cli scaffold my-app   # a new application in ./my-app, before any install
npx caffeine generate modules         # in an application: the module graph, from .caffeinerc.*
npx caffeine static build --root web/dist
npx caffeine static verify --root staged/web
npx caffeine --version
```

The command is a native binary. npm installs the one for your platform as an optional dependency, so an install with
optional dependencies left out (`--omit=optional`) has no `caffeine` to run. Binaries are built for Linux (x64 and
arm64, glibc and musl), macOS (x64 and arm64) and Windows (x64).

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## Static releases

Install `@caffeinejs/static` in the project before running `caffeine static build` or `caffeine static verify`.
The command loads that project's `@caffeinejs/static/build` implementation.

```sh
npx caffeine static build --cwd ./my-app --root web/dist
npx caffeine static verify --cwd ./my-app --root staged/web
```

Place `static` immediately after `caffeine`, followed by `build` or `verify`. `--root DIR` is required.
`--cwd PROJECT` selects the project and defaults to the current working directory. A relative `--root` resolves
from the selected project directory. Each command reports file count, variant count and bytes. Exit codes are
0 for success, 1 for a build or verification failure and 2 for invalid arguments.

## License

[MIT](LICENSE)
