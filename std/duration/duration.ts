export type Duration = number | string

const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g

export function parseDuration(value: Duration): number {
  if (typeof value === 'number') {
    return value
  }

  let total = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(value)) !== null) {
    const n = parseFloat(match[1])
    switch (match[2]) {
      case 'ms':
        total += n / 1000
        break
      case 's':
        total += n
        break
      case 'm':
        total += n * 60
        break
      case 'h':
        total += n * 3600
        break
      case 'd':
        total += n * 86400
        break
    }
  }

  return total
}
