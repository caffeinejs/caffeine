import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// The suites that also run on the fetch application: each imports `createWebApplication` from the Node entry, which
// this project resolves to the fetch application's. A copy of `vitest.config.ts`'s options, not a merge, which would
// concatenate `include`. A suite joins `include` once it passes here.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    swc.vite({
      // Vite already applied the dist file's source map; SWC must not apply it again.
      inputSourceMap: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
  ],
  // @ts-expect-error — oxc is an experimental Vitest option not yet in Vite's types
  oxc: false,
  resolve: {
    alias: [
      {
        find: /^(?:\.\.?\/)+platform\/node\/index\.js$/,
        replacement: fileURLToPath(new URL('./_tests/engine_entry.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'http (engine)',
    pool: 'threads',
    include: [
      'core/routing/decorated.test.ts',
      'decorators/hooks.test.ts',
      '_tests/args_builder.test.ts',
      '_tests/context_headers.test.ts',
      '_tests/context_variables.test.ts',
      '_tests/header.test.ts',
      '_tests/hooks.test.ts',
      '_tests/lifecycle.test.ts',
      '_tests/prefix.test.ts',
      '_tests/timeout.test.ts',
      '_tests/status.test.ts',
      '_tests/redirect.test.ts',
      '_tests/not_found_catch.test.ts',
      '_tests/versioning_decorated_prefix.test.ts',
      '_tests/versioning.test.ts',
      '_tests/versioning_decorated.test.ts',
      '_tests/response_bodies.test.ts',
      'plugin.test.ts',
      '_tests/query_method.test.ts',
      '_tests/router_query_method.test.ts',
      '_tests/health_collision.test.ts',
      'core/health/health.test.ts',
      '_tests/health.test.ts',
      '_tests/register_router.test.ts',
      'core/security/_tests/authentication_gate.test.ts',
      'core/security/_tests/authorization_installation.test.ts',
      'core/security/_tests/authorize_decorators.test.ts',
      'core/security/_tests/multi_scheme.test.ts',
      'core/security/auth/_tests/auth_config.test.ts',
      'core/security/auth/_tests/credentials_hasher.test.ts',
      'core/security/auth/basic/basic.integration.test.ts',
      'core/security/auth/forward/forward.integration.test.ts',
      'core/security/auth/jwt/jwt.integration.test.ts',
      'core/security/auth/opaque/opaque.integration.test.ts',
      'core/security/auth/refresh/refresh.integration.test.ts',
      'core/security/authz/fallback_policy.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
