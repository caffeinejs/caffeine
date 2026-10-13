import type { DevToolsIndex } from '@caffeinejs/devtools'
import { HTML } from '@caffeinejs/html'
import { newRouter, type Context } from '@caffeinejs/http'

import {
  attempt,
  isAnything,
  isBindings,
  isConfiguration,
  isGraph,
  isHealth,
  isIndex,
  isInfo,
  isRoutes,
  type Failure,
} from './failure.js'
import { FailurePage, NotFoundPage, statusOf } from './pages/failure.js'
import { HomePage } from './pages/home.js'
import type { Nav } from './pages/layout.js'
import { OverviewPage } from './pages/overview.js'
import { BindingPage, BindingsPage } from './slices/bindings/page.js'
import { ConfigurationPage } from './slices/configuration/page.js'
import { SlicePage } from './slices/generic/page.js'
import { GraphPage } from './slices/graph/page.js'
import { HealthPage } from './slices/health/page.js'
import { InfoPage } from './slices/info/page.js'
import { RoutesPage } from './slices/routes/page.js'
import { STYLE, STYLE_PATH } from './style.js'
import { kTargets, type Target, type Targets } from './targets.js'

/** An application whose index answered: what a slice page renders around. */
interface Opened {
  readonly ok: true
  readonly target: Target
  readonly index: DevToolsIndex
  readonly nav: Nav
}

/** A page the request ends with instead: an unknown application, an unlisted slice, or an index that failed. */
interface Refused {
  readonly ok: false
  readonly status: number
  readonly page: JSX.Element
}

/** Every page of the UI. */
export function uiRouter() {
  return (
    newRouter('/')
      .name('DevToolsUI')
      .get(STYLE_PATH, ctx => {
        ctx.header('content-type', 'text/css; charset=utf-8')
        // The path names the content, so a browser may keep it for good.
        ctx.header('cache-control', 'public, max-age=31536000, immutable')
        return STYLE
      })

      .get('/')
      .inject({ targets: kTargets })
      .handler(async (_ctx, { targets }) => {
        const rows = await Promise.all(
          targets
            .all()
            .map(async target => ({ name: target.name, index: await attempt(() => target.index.get(), isIndex) })),
        )

        return HTML(HomePage({ nav: { applications: names(targets) }, rows }))
      })

      .get('/:app')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app)
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const listed = new Set(opened.index.slices.map(slice => slice.id))
        const [info, health] = await Promise.all([
          listed.has('info') ? attempt(() => opened.target.info.get(), isInfo) : undefined,
          listed.has('health') ? attempt(() => opened.target.health.get(), isHealth) : undefined,
        ])

        return HTML(OverviewPage({ nav: opened.nav, application: app, index: opened.index, info, health }))
      })

      .get('/:app/bindings')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'bindings')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const report = await attempt(() => opened.target.bindings.get(), isBindings)
        if (!report.ok) {
          return failed(ctx, opened, app, report.failure)
        }

        const query = ctx.req.query() as Record<string, unknown>

        return HTML(
          BindingsPage({
            nav: opened.nav,
            application: app,
            report: report.value,
            filter: { q: first(query.q), internal: first(query.internal) === 'on' },
          }),
        )
      })

      .get('/:app/bindings/:id')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app, id } = ctx.req.param()
        const opened = await open(targets, app, 'bindings')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const withGraph = opened.index.slices.some(slice => slice.id === 'graph')
        const [report, graph] = await Promise.all([
          attempt(() => opened.target.bindings.get(), isBindings),
          withGraph ? attempt(() => opened.target.graph.get(), isGraph) : undefined,
        ])

        if (!report.ok) {
          return failed(ctx, opened, app, report.failure)
        }

        if (graph !== undefined && !graph.ok) {
          return failed(ctx, opened, app, graph.failure)
        }

        const binding = /^\d+$/.test(id)
          ? report.value.bindings.find(candidate => candidate.id === Number(id))
          : undefined
        if (binding === undefined) {
          return refuse(ctx, notFound(opened.nav, `"${app}" holds no binding with the id "${id}".`))
        }

        return HTML(BindingPage({ nav: opened.nav, application: app, binding, graph: graph?.value }))
      })

      .get('/:app/graph')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'graph')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        // The graph's nodes do not say which bindings are internal: the bindings slice does, when it is served.
        const withBindings = opened.index.slices.some(slice => slice.id === 'bindings')
        const [graph, report] = await Promise.all([
          attempt(() => opened.target.graph.get(), isGraph),
          withBindings ? attempt(() => opened.target.bindings.get(), isBindings) : undefined,
        ])

        if (!graph.ok) {
          return failed(ctx, opened, app, graph.failure)
        }

        if (report !== undefined && !report.ok) {
          return failed(ctx, opened, app, report.failure)
        }

        const query = ctx.req.query() as Record<string, unknown>
        const internal =
          report === undefined
            ? undefined
            : new Set(report.value.bindings.filter(binding => binding.internal).map(binding => binding.id))

        return HTML(
          GraphPage({
            nav: opened.nav,
            application: app,
            graph: graph.value,
            internal,
            showInternal: first(query.internal) === 'on',
            linkBindings: withBindings,
          }),
        )
      })

      .get('/:app/routes')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'routes')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const report = await attempt(() => opened.target.routes.get(), isRoutes)

        return report.ok
          ? HTML(RoutesPage({ nav: opened.nav, application: app, report: report.value }))
          : failed(ctx, opened, app, report.failure)
      })

      .get('/:app/health')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'health')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const report = await attempt(() => opened.target.health.get(), isHealth)

        return report.ok
          ? HTML(HealthPage({ nav: opened.nav, application: app, report: report.value }))
          : failed(ctx, opened, app, report.failure)
      })

      .get('/:app/info')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'info')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const report = await attempt(() => opened.target.info.get(), isInfo)

        return report.ok
          ? HTML(InfoPage({ nav: opened.nav, application: app, report: report.value }))
          : failed(ctx, opened, app, report.failure)
      })

      .get('/:app/configuration')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app } = ctx.req.param()
        const opened = await open(targets, app, 'configuration')
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const report = await attempt(() => opened.target.configuration.get(), isConfiguration)

        return report.ok
          ? HTML(ConfigurationPage({ nav: opened.nav, application: app, report: report.value }))
          : failed(ctx, opened, app, report.failure)
      })

      // Any other slice the application lists: the generic page shows a new one with no change here.
      .get('/:app/:slice')
      .inject({ targets: kTargets })
      .handler(async (ctx, { targets }) => {
        const { app, slice } = ctx.req.param()
        const opened = await open(targets, app, slice)
        if (!opened.ok) {
          return refuse(ctx, opened)
        }

        const value = await attempt(() => opened.target.slice.get(slice), isAnything)

        return value.ok
          ? HTML(SlicePage({ nav: opened.nav, application: app, id: slice, value: value.value }))
          : failed(ctx, opened, app, value.failure)
      })
  )
}

/**
 * Finds the application and reads its index, then checks that it serves `slice`. Nothing else of the application is
 * called until then, so an unknown application or an unlisted slice costs one call at most.
 */
async function open(targets: Targets, name: string, slice?: string): Promise<Opened | Refused> {
  const applications = names(targets)
  const target = targets.get(name)

  if (target === undefined) {
    return notFound({ applications }, `No application named "${name}" is configured.`)
  }

  // A dot segment would be resolved away before the request left, and call another path than the one listed.
  if (slice === '.' || slice === '..') {
    return notFound({ applications, application: name }, `"${name}" does not serve a slice named "${slice}".`)
  }

  const index = await attempt(() => target.index.get(), isIndex)

  if (!index.ok) {
    return {
      ok: false,
      status: statusOf(index.failure),
      page: FailurePage({ nav: { applications, application: name }, application: name, failure: index.failure }),
    }
  }

  const nav: Nav = { applications, application: name, slices: index.value.slices.map(entry => entry.id), active: slice }

  if (slice !== undefined && !nav.slices!.includes(slice)) {
    return notFound(nav, `"${name}" does not serve a slice named "${slice}".`)
  }

  return { ok: true, target, index: index.value, nav }
}

function notFound(nav: Nav, what: string): Refused {
  return { ok: false, status: 404, page: NotFoundPage({ nav, what }) }
}

function refuse(ctx: Context, refused: Refused) {
  ctx.status(refused.status)
  return HTML(refused.page)
}

function failed(ctx: Context, opened: Opened, application: string, failure: Failure) {
  ctx.status(statusOf(failure))
  return HTML(FailurePage({ nav: opened.nav, application, failure }))
}

function names(targets: Targets): string[] {
  return targets.all().map(target => target.name)
}

// A query parameter given twice arrives as a list: the page reads the first.
function first(value: unknown): string {
  if (Array.isArray(value)) {
    return first(value[0])
  }

  return typeof value === 'string' ? value : ''
}
