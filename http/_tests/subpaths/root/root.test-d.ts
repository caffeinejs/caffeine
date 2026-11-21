import { Router } from '@caffeinejs/http'

// A consumer of the package root alone, in a program of its own: every option field the root's own modules declare is
// in sight, the framework's own markers included. `npm run test:typecheck` is the test.

new Router('/a').get('/', ctx => ({
  oidc: ctx.options.oidcRoute,
  probe: ctx.options.healthProbe,
  exempt: ctx.options.accessControlExempt,
  cors: ctx.options.cors,
  csrf: ctx.options.csrf,
  constraints: ctx.options.constraints,
}))
