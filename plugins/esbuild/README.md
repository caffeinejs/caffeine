# @caffeinejs/esbuild-plugin

An esbuild plugin that runs `caffeine generate modules` before every build.

```sh
npm install -E -D @caffeinejs/esbuild-plugin @caffeinejs/cli
```

```ts
import { caffeineEsbuild } from '@caffeinejs/esbuild-plugin'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  outdir: 'dist',
  plugins: [caffeineEsbuild()],
})
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
