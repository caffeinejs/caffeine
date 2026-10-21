import { injectableDeps } from './rules/index.js'

const plugin = {
  meta: {
    name: '@caffeinejs/eslint-plugin',
    version: '0.0.0',
  },
  rules: {
    'injectable-deps': injectableDeps,
  },
}

export default plugin
