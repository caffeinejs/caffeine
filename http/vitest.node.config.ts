import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// The suites that run on the Node application: each imports `createWebApplication` from the Fastify entry, which this
// project resolves to the Node application's. A copy of `vitest.config.ts`'s options, not a merge, which would
// concatenate `include` and run every suite.
//
// Re-pinned on Node, the Fastify-specific suites whose behavior a test beside the Node module pins again:
// - _tests/graceful_shutdown.test.ts -> platform/node/connections.test.ts
// - _tests/https.test.ts -> platform/node/node.test.ts, platform/node/connections.test.ts
// - _tests/https.test-d.ts -> platform/node/node.test-d.ts
// - platform/fastify/adapter_server.test.ts -> platform/node/node.test.ts
// - platform/node/inject.fastify.test.ts -> platform/node/inject.test.ts
// - _tests/request_host.test.ts -> core/server/context.test.ts, platform/node/platform.test.ts
// - platform/fastify/context.test.ts (signal, id) -> platform/node/platform.test.ts, core/server/context.test.ts
// - core/listener/_tests/tls.test.ts -> platform/node/node.test.ts
//
// Not yet on Node, each with what keeps it off:
// - _tests/body_limit.test.ts: reads a body, declares a schema or a @BodyLimit, which the engine refuses
// - _tests/context_platform.test.ts: installs middleware, which the engine refuses
// - _tests/context_variables.test.ts: installs middleware, which the engine refuses
// - _tests/create_web_application.test.ts: reads a Fastify-only member of app.instance
// - _tests/fetch.test.ts: reads a Fastify-only member of app.instance
// - _tests/graceful_shutdown.test.ts: needs healthProbes(), not on the Node entry yet
// - _tests/health_collision.test.ts: needs healthProbes(), not on the Node entry yet
// - _tests/health.test.ts: needs healthProbes(), not on the Node entry yet
// - _tests/lifecycle.test.ts: expects request() to reject after close(); the engine answers a plain 503
// - _tests/programmatic_router_parity.test.ts: needs authentication(), not on the Node entry yet
// - _tests/query_method.test.ts: reads a body, declares a schema or a @BodyLimit, which the engine refuses
// - _tests/register_router.test.ts: needs authentication(), not on the Node entry yet
// - _tests/response_bodies.test.ts: installs middleware, which the engine refuses
// - _tests/router_query_method.test.ts: reads a body, declares a schema or a @BodyLimit, which the engine refuses
// - _tests/versioning_decorated.test.ts: needs constraints(), not on the Node entry yet
// - _tests/versioning.test.ts: needs constraints(), not on the Node entry yet
// - core/health/health.test.ts: needs healthProbes(), not on the Node entry yet
// - core/listener/_tests/health.test.ts: needs healthProbes(), not on the Node entry yet
// - core/security/_tests/authentication_gate_registration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/_tests/authentication_gate.test.ts: needs authentication(), not on the Node entry yet
// - core/security/_tests/authorization_installation.test.ts: needs authentication(), not on the Node entry yet
// - core/security/_tests/authorize_decorators.test.ts: needs authentication(), not on the Node entry yet
// - core/security/_tests/multi_scheme.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/_tests/auth_config.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/_tests/credentials_hasher.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/basic/basic.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/cookie/cookie.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/forward/forward.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/jwt/jwt.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/oidc/oidc.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/opaque/opaque.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/auth/refresh/refresh.integration.test.ts: needs authentication(), not on the Node entry yet
// - core/security/authz/authz.test.ts: needs authentication(), not on the Node entry yet
// - core/security/authz/fallback_policy.test.ts: needs authentication(), not on the Node entry yet
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
        replacement: fileURLToPath(new URL('./_tests/node_entry.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'http (node)',
    pool: 'threads',
    include: [
      '_tests/args_builder.test.ts',
      '_tests/attachment.prop.test.ts',
      '_tests/attachment.test.ts',
      '_tests/context_headers.test.ts',
      '_tests/header.test.ts',
      '_tests/http_plugin_controller_mount.test.ts',
      '_tests/not_found_catch.test.ts',
      '_tests/prefix.test.ts',
      '_tests/redirect.test.ts',
      '_tests/status.test.ts',
      '_tests/timeout.test.ts',
      '_tests/versioning_decorated_prefix.test.ts',
      'application.test.ts',
      'core/error/_tests/catch_by_ambiguous.test.ts',
      'core/error/_tests/catch_by_not_a_handler.test.ts',
      'core/error/_tests/catch_by_unknown_ref.test.ts',
      'core/error/_tests/controller_duplicate_handler.test.ts',
      'core/error/_tests/duplicate_handler.test.ts',
      'core/error/_tests/error_return_value.test.ts',
      'core/error/_tests/route_and_handler.test.ts',
      'core/error/_tests/untagged_handler.test.ts',
      'core/error/serializer.test.ts',
      'core/routing/inventory.test.ts',
      'core/security/_tests/route_scheme_assert.test.ts',
      'response.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
