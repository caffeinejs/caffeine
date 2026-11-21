import { Version } from '@caffeinejs/http/constraints'
import { CSRFExempt } from '@caffeinejs/http/csrf'
import { CORS } from '@caffeinejs/http/decorators'
import { Router } from '@caffeinejs/http/routing'

// A consumer that imports a decorator through its published subpath, in a program of its own: the decorator brings the
// option field it writes. `npm run test:typecheck` is the test.

void Version
void CSRFExempt
void CORS

new Router('/a')
  .routeOptions({ constraints: new Map([['flavor', { value: 'x' }]]), csrf: { exempt: true }, cors: false })
  .get('/', ctx => ({ constraints: ctx.options.constraints?.size, exempt: ctx.options.csrf?.exempt }))
