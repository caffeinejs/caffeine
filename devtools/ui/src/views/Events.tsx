import { EventBadge } from '../components/ui/Badge.js'
import type { DevtoolsEvent } from '../ws/protocol.js'

interface Props {
  events: DevtoolsEvent[]
}

export function Events({ events }: Props) {
  const reversed = [...events].reverse()

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Events</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {events.length}
          {' '}
          {events.length === 1 ? 'event' : 'events'}
          {' '}
          received — newest first
        </p>
      </div>
      <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-200/50 dark:border-zinc-800 dark:divide-zinc-800/50">
        {reversed.length === 0
          ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                No events yet.
              </p>
            )
          : reversed.map((e, i) => (
              <div
                key={i}
                className="flex items-start gap-4 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
              >
                <span className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-zinc-400 dark:text-zinc-600">
                  {new Date(e.ts).toISOString()
                    .replace('T', ' ')
                    .slice(0, 23)}
                </span>
                <EventBadge kind={e.kind} />
                <span className="break-all font-mono text-xs text-zinc-500">
                  {JSON.stringify(e.payload)}
                </span>
              </div>
            ))}
      </div>
    </div>
  )
}
