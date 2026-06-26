import type { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  className?: string
}

function Badge({ children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-medium ${className}`}
    >
      {children}
    </span>
  )
}

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400',
  POST: 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400',
  PUT: 'bg-sky-500/10 text-sky-600 border-sky-500/20 dark:text-sky-400',
  PATCH: 'bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400',
  DELETE: 'bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400',
  HEAD: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20',
  OPTIONS: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20',
}

const EVENT_STYLES: Record<string, string> = {
  'binding:registered': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400',
  'binding:initialized': 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400',
  'binding:initialization-failed': 'bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400',
  'module:registered': 'bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400',
  'module:failed': 'bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400',
  'container:disposed': 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20 dark:text-yellow-400',
}

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase()
  return (
    <Badge className={METHOD_STYLES[m] ?? 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'}>
      {m}
    </Badge>
  )
}

export function EventBadge({ kind }: { kind: string }) {
  return (
    <Badge className={EVENT_STYLES[kind] ?? 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'}>
      {kind}
    </Badge>
  )
}

export function ScopeBadge({ scope }: { scope: string }) {
  const label = scope
    .replace(/^Symbol\((.+)\)$/, '$1')
    .replace(/^@caffeinejs\/core:/, '')

  const style
    = label === 'singleton'
      ? 'bg-rose-500/10 text-rose-600 border-rose-500/20 dark:text-rose-400'
      : label === 'request'
        ? 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20 dark:text-cyan-400'
        : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'

  return <Badge className={style}>{label}</Badge>
}

export function FlagBadge({ value, label }: { value: boolean, label: string }) {
  if (!value) {
    return <span className="text-zinc-400 dark:text-zinc-600">—</span>
  }
  return (
    <Badge className="border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600/30 dark:bg-zinc-700/50 dark:text-zinc-300">
      {label}
    </Badge>
  )
}
