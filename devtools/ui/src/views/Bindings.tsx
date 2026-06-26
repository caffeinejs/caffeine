import { FlagBadge, ScopeBadge } from '../components/ui/Badge.js'
import { Table, type Column } from '../components/ui/Table.js'
import type { BindingSnapshot } from '../ws/protocol.js'

interface Props {
  bindings: BindingSnapshot[]
}

const COLUMNS: Column<BindingSnapshot>[] = [
  {
    key: 'key',
    header: 'Key',
    render: b => <span className="font-mono text-zinc-800 dark:text-zinc-200">{b.key}</span>,
  },
  {
    key: 'scope',
    header: 'Scope',
    render: b => <ScopeBadge scope={b.scopeId} />,
  },
  {
    key: 'names',
    header: 'Names',
    render: b =>
      b.names.length > 0
        ? <span className="font-mono text-zinc-600 dark:text-zinc-400">{b.names.join(', ')}</span>
        : <span className="text-zinc-400 dark:text-zinc-600">—</span>,
  },
  {
    key: 'primary',
    header: 'Primary',
    render: b => <FlagBadge value={b.primary} label="primary" />,
  },
  {
    key: 'lazy',
    header: 'Lazy',
    render: b => <FlagBadge value={b.lazy} label="lazy" />,
  },
  {
    key: 'async',
    header: 'Async',
    render: b => <FlagBadge value={b.async} label="async" />,
  },
]

export function Bindings({ bindings }: Props) {
  const visible = bindings.filter(b => !b.internal)

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Bindings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {visible.length}
          {' '}
          {visible.length === 1 ? 'binding' : 'bindings'}
          {' '}
          registered in the container
        </p>
      </div>
      <Table
        columns={COLUMNS}
        rows={visible}
        keyFn={b => b.id}
        empty="No bindings registered yet."
      />
    </div>
  )
}
