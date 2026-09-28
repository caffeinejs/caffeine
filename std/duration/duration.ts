export type Duration = number | string

/**
 * JSON Schema `pattern` for a {@link Duration} string.
 *
 * Anchored; mirrors the grammar {@link parseDuration} accepts — one or more `<number><unit>`
 * segments, units `ms|s|m|h|d`. Rejects input {@link parseDuration} would otherwise read as `0`.
 */
export const DURATION_PATTERN = '^(?:\\d+(?:\\.\\d+)?(?:ms|s|m|h|d))+$'

// Consume digit runs even when no unit follows, rather than retrying at every digit.
const re = /\d+(?:\.\d+)?/g

export function parseDuration(value: Duration): number {
  if (typeof value === 'number') {
    return value
  }

  let total = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(value)) !== null) {
    const n = parseFloat(match[0])
    switch (value[re.lastIndex]) {
      case 's':
        total += n
        break
      case 'm':
        total += value[re.lastIndex + 1] === 's' ? n / 1000 : n * 60
        break
      case 'h':
        total += n * 3600
        break
      case 'd':
        total += n * 86400
        break
      default: {
        // A later decimal can still form a duration: `1.2.3s` contains `2.3s`.
        const dot = match[0].indexOf('.')
        if (dot !== -1) {
          re.lastIndex = match.index + dot + 1
        }
      }
    }
  }

  return total
}

/**
 * Normalizes a {@link Duration} to milliseconds.
 *
 * {@link parseDuration} returns **seconds** for a string and passes a number through untouched, so its output can
 * never reach a timer directly. A number here is already milliseconds.
 */
export function toMillis(value: Duration): number {
  return typeof value === 'number' ? value : Math.round(parseDuration(value) * 1000)
}
