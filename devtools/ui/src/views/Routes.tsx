import { MethodBadge, ScopeBadge } from '../components/ui/Badge.js'
import { Table, type Column } from '../components/ui/Table.js'
import type { RouteSnapshot } from '../ws/protocol.js'

interface Props {
  routes: RouteSnapshot[]
}

const COLUMNS: Column<RouteSnapshot>[] = [
  {
    key: 'method',
    header: 'Method',
    render: r => (
      <div className="flex flex-wrap gap-1">
        {r.method.map(m => <MethodBadge key={m} method={m} />)}
      </div>
    ),
  },
  {
    key: 'path',
    header: 'Path',
    render: r => <span className="font-mono text-zinc-800 dark:text-zinc-200">{r.path}</span>,
  },
  {
    key: 'controller',
    header: 'Controller',
    render: r => <span className="font-mono text-zinc-600 dark:text-zinc-400">{r.controllerKey}</span>,
  },
  {
    key: 'scope',
    header: 'Scope',
    render: r => <ScopeBadge scope={r.controllerScope} />,
  },
  {
    key: 'handler',
    header: 'Handler',
    render: r => <span className="font-mono text-zinc-600 dark:text-zinc-400">{r.handler}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: r => {
      const status = r.responseStatus ?? 200
      const color
        = status < 300
          ? 'text-emerald-600 dark:text-emerald-400'
          : status < 400
            ? 'text-yellow-600 dark:text-yellow-400'
            : 'text-red-600 dark:text-red-400'
      return <span className={`font-mono ${color}`}>{status}</span>
    },
  },
]

export function Routes({ routes }: Props) {
  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Routes</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {routes.length}
          {' '}
          {routes.length === 1 ? 'route' : 'routes'}
          {' '}
          registered
        </p>
      </div>
      <Table
        columns={COLUMNS}
        rows={routes}
        keyFn={(_, i) => i}
        empty="No routes registered. Attach an HTTP adapter to see routes."
      />
    </div>
  )
}
