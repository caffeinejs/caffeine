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
// - core/middleware/pipeline.test.ts -> core/middleware/chain.test.ts, platform/node/platform.test.ts (Node middleware)
// - _tests/http_plugin.test.ts (a Fastify plugin's slot) -> plugin_slot.test.ts, servers.test.ts, _tests/hooks.test.ts
// - core/middleware/middleware.test.ts -> core/middleware/chain.test.ts, core/server/hooks.test.ts,
//   core/server/server.test.ts (HTTPServer middleware), platform/node/platform.test.ts (Node middleware)
// - _tests/http_plugin_controller.test.ts -> decorators/hooks.test.ts, core/routing/decorated.test.ts,
//   core/server/hooks.test.ts (a router plugin's middleware)
// - _tests/context_platform.test.ts -> platform/node/platform.test.ts (ctx.platform on Node)
// - core/listener/_tests/{decorated,plugins,routers}.test.ts -> core/listener/listener.test.ts,
//   core/server/adapter.test.ts (a listener's own routes and plugins)
// - _tests/body_limit.test.ts -> core/server/input.test.ts (its bad-limit cases pin Fastify's own message)
// - _tests/body_as_buffer.test.ts -> core/server/input.test.ts
// - _tests/body_as_stream.test.ts -> core/server/input.test.ts
// - platform/fastify/form/form.test.ts -> core/server/body.test.ts, core/server/input.test.ts
// - platform/fastify/routing/schema/_tests/route_validation.test.ts -> core/validation/typebox.test.ts,
//   core/server/input.test.ts
// - platform/fastify/error/validation.test.ts -> core/error/validation.test.ts
// - core/cookie/cookie.test.ts -> core/cookie/server_cookies.test.ts, core/server/context.test.ts
// - core/csrf/_tests/csrf_plugin.test.ts -> core/csrf/csrf.test.ts (in part: the verdicts, exemptions, proxy and
//   downgrade cases, checks, logging and the router scope)
// - core/security/_tests/authentication_gate_registration.test.ts -> core/security/security.test.ts (duplicate gates;
//   the code is ERR_CONFIGURATION there)
//
// Not yet on Node, each with what keeps it off:
// - _tests/context_platform.test.ts: reads Fastify's ctx.platform.request and ctx.platform.reply
// - _tests/create_web_application.test.ts: reads a Fastify-only member of app.instance
// - _tests/fetch.test.ts: reads a Fastify-only member of app.instance
// - _tests/http_plugin.test.ts: installs a Fastify plugin with .with(...)
// - _tests/http_plugin_controller.test.ts: installs a Fastify plugin with @Use(...)
// - _tests/lifecycle.test.ts: expects request() to reject after close(); the engine answers a plain 503
// - _tests/programmatic_router_parity.test.ts: needs constraints() (5c)
// - _tests/versioning_decorated.test.ts: needs constraints(), not on the Node entry yet
// - _tests/versioning.test.ts: needs constraints(), not on the Node entry yet
// - core/csrf/_tests/csrf_edges.test.ts: installs a Fastify plugin
// - core/csrf/_tests/csrf_plugin.test.ts: installs a Fastify plugin
// - core/csrf/_tests/csrf_webhook.test.ts: installs a Fastify plugin
// - core/listener/_tests/auth.test.ts: passes Fastify's { listener } settings
// - core/listener/_tests/decorated.test.ts: passes Fastify's { listener } settings
// - core/listener/_tests/health.test.ts: passes Fastify's { listener } settings
// - core/listener/_tests/plugins.test.ts: passes Fastify's { listener } settings
// - core/listener/_tests/routers.test.ts: passes Fastify's { listener } settings
// - core/middleware/middleware.test.ts: installs a Fastify plugin, and passes Fastify's { factory } settings
// - core/security/_tests/authentication_gate_coverage.test.ts: installs a Fastify plugin
// - core/security/_tests/authentication_gate_fallback.test.ts: installs a Fastify plugin
// - core/security/_tests/authentication_gate_order.test.ts: installs a Fastify plugin
// - core/security/_tests/authentication_gate_registration.test.ts: imports newRouter from a Fastify path
// - core/security/auth/oidc/failure_responses.test.ts: installs a Fastify plugin
// - core/security/auth/oidc/oidc.fastify.test.ts: pins a router gate claiming the OIDC routes, which only Fastify does
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
      'core/routing/decorated.test.ts',
      'decorators/hooks.test.ts',
      '_tests/args_builder.test.ts',
      '_tests/attachment.prop.test.ts',
      '_tests/attachment.test.ts',
      '_tests/context_headers.test.ts',
      '_tests/context_variables.test.ts',
      '_tests/header.test.ts',
      '_tests/hooks.test.ts',
      '_tests/http_plugin_controller_mount.test.ts',
      '_tests/not_found_catch.test.ts',
      '_tests/prefix.test.ts',
      '_tests/redirect.test.ts',
      '_tests/response_bodies.test.ts',
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
      'plugin.test.ts',
      'response.test.ts',
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
      'core/security/auth/_tests/auth_config_options.test.ts',
      'core/security/auth/cookie/cookie.integration.test.ts',
      'core/security/auth/oidc/oidc.integration.test.ts',
      'core/security/authz/authz.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
