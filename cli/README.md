# @caffeinejs/cli

The `caffeine` command of CaffeineJS: it scaffolds a new application and generates the code an application builds
from, such as its module graph.

```sh
npm install -E -D @caffeinejs/cli
```

```sh
npx @caffeinejs/cli scaffold my-app   # a new application in ./my-app, before any install
npx caffeine generate modules         # in an application: the module graph, from .caffeinerc.*
npx caffeine --version
```

The command is a native binary. npm installs the one for your platform as an optional dependency, so an install with
optional dependencies left out (`--omit=optional`) has no `caffeine` to run. Binaries are built for Linux (x64 and
arm64, glibc and musl), macOS (x64 and arm64) and Windows (x64).

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
