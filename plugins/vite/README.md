# @caffeinejs/vite-plugin

A Vite plugin that runs `caffeine generate modules` when a build starts, and again when the dev server sees a file
added or removed.

```sh
npm install -E -D @caffeinejs/vite-plugin @caffeinejs/cli
```

```ts
import { caffeineVite } from '@caffeinejs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [caffeineVite()],
})
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
