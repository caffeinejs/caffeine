# @caffeinejs/eslint-plugin

ESLint rules for CaffeineJS applications. `injectable-deps` requires `@Injectable()` and `@Configuration()` to
declare a deps array when the constructor has parameters.

```sh
npm install -E -D @caffeinejs/eslint-plugin
```

```js
// eslint.config.js
import caffeine from '@caffeinejs/eslint-plugin'

export default [
  {
    plugins: { '@caffeinejs': caffeine },
    rules: { '@caffeinejs/injectable-deps': 'error' },
  },
]
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
