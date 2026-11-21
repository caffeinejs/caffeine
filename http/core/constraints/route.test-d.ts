import { Router } from '../routing/programmatic/programmatic.js'
import type { ResolvedRouteConstraint } from './keys.js'

// Route constraints are matched from a native Map: a read-only view of one would be refused at start-up, so the type
// refuses it first. `npm run test:typecheck` is the test.

const view: ReadonlyMap<string, ResolvedRouteConstraint> = new Map([['flavor', { value: 'x' }]])

// @ts-expect-error a ReadonlyMap is not the Map the matcher reads
new Router('/a').get('/').config({ constraints: view })

new Router('/a').get('/').config({ constraints: new Map([['flavor', { value: 'x' }]]) })
