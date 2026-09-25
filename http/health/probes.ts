import type { IndicatorOutcome, ProbeResult } from '@caffeinejs/std/health'

/** The query a probe request carries. Both parameters are honoured only when enabled in `HealthOptions`. */
export interface ProbeQuery {
  verbose?: boolean
  exclude?: readonly string[]
}

/** A rendered probe response, independent of any HTTP server. */
export interface ProbeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const PROBE_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * Renders a probe's verdict in the plain-text shape `kubectl get --raw /readyz?verbose` already produces: `ok` or
 * `<probe> check failed` in brief, one `[+]`/`[-]` line per check and indicator when `verbose`. An indicator's
 * line carries its `detail`, never its `data`.
 */
export function renderProbe(probe: string, result: ProbeResult, verbose: boolean): ProbeResponse {
  const status = result.ok ? 200 : 503

  if (!verbose) {
    return { status, headers: PROBE_HEADERS, body: result.ok ? 'ok' : `${probe} check failed` }
  }

  const lines = result.checks.map(check => renderLine(check.name, check.ok, check.detail))
  for (const outcome of result.outcomes) {
    lines.push(renderIndicator(outcome))
  }
  lines.push(`${probe} check ${result.ok ? 'passed' : 'failed'}`)

  return { status, headers: PROBE_HEADERS, body: lines.join('\n') + '\n' }
}

function renderLine(name: string, ok: boolean, detail?: string): string {
  if (ok) {
    return `[+]${name} ok`
  }

  return detail === undefined ? `[-]${name} failed` : `[-]${name} failed: ${detail}`
}

function renderIndicator(outcome: IndicatorOutcome): string {
  if (outcome.status === 'up') {
    return `[+]${outcome.name} ok`
  }

  const label = outcome.status === 'degraded' || !outcome.critical ? 'degraded' : 'failed'
  const suffix = outcome.detail === undefined ? '' : `: ${outcome.detail}`

  return `[-]${outcome.name} ${label}${suffix}`
}
