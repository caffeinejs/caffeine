import { Version } from '@caffeinejs/http/constraints'
import { CSRFExempt } from '@caffeinejs/http/csrf'
import { Router } from '@caffeinejs/http/routing'

// A consumer that imports a decorator through its published subpath, in a program of its own: the decorator brings the
// option field it writes. `npm run test:typecheck` is the test.

void Version
void CSRFExempt

new Router('/a')
  .routeOptions({ constraints: new Map([['flavor', { value: 'x' }]]), csrf: { exempt: true } })
  .get('/', ctx => ({ constraints: ctx.options.constraints?.size, exempt: ctx.options.csrf?.exempt }))
