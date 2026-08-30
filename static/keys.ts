import { token } from '@caffeinejs/di'
import type { SPASettings } from './spa.js'
import type { StaticMount } from './static.js'

/**
 * DI key for the configured static mounts ({@link StaticMount}[]) — the directories the adapter serves via
 * `@fastify/static`. Bound by `app.static(s => s.serve(dir, { prefix }))`. When unbound, no static route
 * is registered.
 */
export const kStaticMounts = token<StaticMount[]>(Symbol.for('@caffeinejs/static:mounts'))

/**
 * DI key for the resolved SPA settings ({@link SPASettings}), bound by `app.static(s => s.spa(dir))`. Unbound
 * when no SPA was configured, which is what makes the fallback and its diagnostics inert.
 */
export const kSPASettings = token<SPASettings>(Symbol.for('@caffeinejs/static:spa-settings'))
