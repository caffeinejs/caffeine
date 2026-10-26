/** A status word, coloured by what it says, escaped: it is often a value the devtools answered. */
export function Badge(props: { tone: 'good' | 'bad' | 'warn' | 'muted'; text: string }): JSX.Element {
  return (
    <span class={`badge badge-${props.tone}`} safe>
      {props.text}
    </span>
  )
}

/** A two-column list of labelled values; every value is escaped. */
export function KeyValue(props: { rows: ReadonlyArray<readonly [string, unknown]> }): JSX.Element {
  return (
    <dl class="kv">
      {props.rows.map(([key, value]) => (
        <>
          <dt safe>{key}</dt>
          <dd safe>{display(value)}</dd>
        </>
      ))}
    </dl>
  )
}

/** Any value as indented JSON, escaped. */
export function JSONView(props: { value: unknown }): JSX.Element {
  return (
    <pre class="json" safe>
      {JSON.stringify(props.value, null, 2)}
    </pre>
  )
}

/** A value as one line of text: a list joined, nothing as a dash. */
export function display(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '—'
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map(display).join(', ')
  }

  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** A byte count as text a person reads: `12.3 MiB`. */
export function bytes(count: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = count
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}
