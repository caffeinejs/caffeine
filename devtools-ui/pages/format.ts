const UNITS = ['B', 'KiB', 'MiB', 'GiB']

export function bytes(value: number): string {
  let amount = value
  let unit = 0

  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024
    unit++
  }

  return `${unit === 0 ? amount : amount.toFixed(1)} ${UNITS[unit]}`
}

/** A span of seconds, to the largest two units: `3d 4h`, `5m 12s`. */
export function uptime(seconds: number): string {
  const parts: Array<[number, string]> = [
    [Math.floor(seconds / 86_400), 'd'],
    [Math.floor((seconds % 86_400) / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
    [Math.floor(seconds % 60), 's'],
  ]
  const first = parts.findIndex(([amount]) => amount > 0)

  return first === -1
    ? '0s'
    : parts
        .slice(first, first + 2)
        .map(([amount, unit]) => `${amount}${unit}`)
        .join(' ')
}

export function milliseconds(value: number): string {
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

export function timestamp(ms: number): string {
  return ms === 0 ? 'never' : new Date(ms).toISOString()
}
