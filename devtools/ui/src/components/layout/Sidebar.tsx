import type { Tab } from '../../types.js'

interface NavItem {
  id: Tab
  label: string
  count: number
}

interface NavSection {
  title: string
  items: NavItem[]
}

interface Props {
  tab: Tab
  onTab: (t: Tab) => void
  connected: boolean
  counts: Record<Tab, number>
}

export function Sidebar({ tab, onTab, connected, counts }: Props) {
  const sections: NavSection[] = [
    {
      title: 'Application',
      items: [
        { id: 'bindings', label: 'Bindings', count: counts.bindings },
        { id: 'events', label: 'Events', count: counts.events },
      ],
    },
    {
      title: 'Endpoints',
      items: [
        { id: 'routes', label: 'Routes', count: counts.routes },
      ],
    },
  ]

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-12 shrink-0 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">CaffeineJS</span>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Devtools</span>
        </div>
      </div>

      <div className="border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? 'bg-emerald-400' : 'bg-red-400'
            }`}
          />
          <span
            className={`text-xs ${
              connected
                ? 'text-zinc-600 dark:text-zinc-400'
                : 'text-zinc-400 dark:text-zinc-500'
            }`}
          >
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-4">
        {sections.map(section => (
          <div key={section.title}>
            <p className="mb-1.5 px-3 text-base font-extrabold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map(item => {
                const active = item.id === tab
                return (
                  <button
                    key={item.id}
                    onClick={() => onTab(item.id)}
                    className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-red-500/10 text-red-400'
                        : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                    }`}
                  >
                    <span>{item.label}</span>
                    <span
                      className={`tabular-nums text-xs ${
                        active ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-600'
                      }`}
                    >
                      {item.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <p className="text-xs text-zinc-400 dark:text-zinc-600">@caffeinejs/devtools</p>
      </div>
    </aside>
  )
}
