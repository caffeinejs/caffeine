import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// The suites that run on the fetch application: each imports `createWebApplication` from the Fastify entry, which this
// project resolves to the fetch application's. A copy of `vitest.config.ts`'s options, not a merge, which would
// concatenate `include` and run every suite.
//
// Re-pinned on the engine, the Fastify-specific suites whose behavior a test beside the engine's module pins again:
// - core/middleware/pipeline.test.ts -> core/middleware/chain.test.ts
// - _tests/http_plugin.test.ts (a Fastify plugin's slot) -> plugin_slot.test.ts, servers.test.ts, _tests/hooks.test.ts
// - core/middleware/middleware.test.ts -> core/middleware/chain.test.ts, core/server/hooks.test.ts,
//   core/server/server.test.ts (HTTPServer middleware), platform/node/platform.test.ts (Node middleware)
// - _tests/http_plugin_controller.test.ts -> decorators/hooks.test.ts, core/routing/decorated.test.ts,
//   core/server/hooks.test.ts (a router plugin's middleware)
// - _tests/context_platform.test.ts -> platform/node/platform.test.ts (ctx.platform on Node)
// - core/listener/_tests/{decorated,plugins,routers}.test.ts -> core/listener/listener.test.ts,
//   core/server/adapter.test.ts (a listener's own routes and plugins)
//
// Not yet on the engine, each with what keeps it off:
// - _tests/context_platform.test.ts: reads Fastify's ctx.platform.request and ctx.platform.reply
// - _tests/http_plugin.test.ts: imports newRouter, which the fetch entry does not export
// - _tests/http_plugin_controller.test.ts: installs a Fastify plugin with @Use(...)
// - core/listener/_tests/decorated.test.ts: passes Fastify's { listener } settings
// - core/listener/_tests/plugins.test.ts: imports newRouter, which the fetch entry does not export
// - core/listener/_tests/routers.test.ts: imports newRouter, which the fetch entry does not export
// - core/middleware/middleware.test.ts: installs Node middleware, which the fetch application has no request for, a
//   Fastify plugin, and Fastify's { factory } settings
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
        find: /^(?:\.\.?\/)+platform\/fastify\/index\.js$/,
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
      '_tests/prefix.test.ts',
      '_tests/timeout.test.ts',
      '_tests/status.test.ts',
      '_tests/redirect.test.ts',
      '_tests/not_found_catch.test.ts',
      '_tests/versioning_decorated_prefix.test.ts',
      '_tests/response_bodies.test.ts',
      'plugin.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
