// The most ranges one request is served, as Spring caps them: past it, the body goes out whole (RFC 9110 §14.2: a
// server MAY ignore Range).
const MOST_RANGES = 100

/**
 * The byte ranges a `Range` header asks of a body of `size` bytes, as RFC 9110 §14 reads it.
 *
 * Each `[first, last]` lies inside the body, in the order asked for, with those starting past its end left out, or
 * `'unsatisfiable'` when that leaves none. `undefined` when the body is to be sent whole: no header, another unit, a
 * malformed or reversed range, an empty body, more than 100 ranges, or ranges adding up to more than the body, which
 * only a broken client or an attack asks for (§14.2).
 */
export function byteRanges(
  header: string | undefined,
  size: number,
): ReadonlyArray<readonly [number, number]> | 'unsatisfiable' | undefined {
  if (header === undefined || size === 0) {
    return undefined
  }

  // The unit is compared without regard to case.
  const equals = header.indexOf('=')
  if (equals === -1 || header.slice(0, equals).toLowerCase() !== 'bytes') {
    return undefined
  }

  // Empty list elements are skipped, as a list's recipient must.
  const specs = header
    .slice(equals + 1)
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec !== '')
  if (specs.length === 0 || specs.length > MOST_RANGES) {
    return undefined
  }

  const ranges: Array<readonly [number, number]> = []
  let total = 0

  for (const spec of specs) {
    const range = rangeOf(spec, size)

    if (range === undefined) {
      return undefined
    }

    if (range !== 'unsatisfiable') {
      ranges.push(range)
      total += range[1] - range[0] + 1
    }
  }

  if (ranges.length === 0) {
    return 'unsatisfiable'
  }

  return total > size ? undefined : ranges
}

// One range of a body of `size` bytes, `'unsatisfiable'` for one starting past its end, `undefined` for one that is
// malformed or reversed.
function rangeOf(spec: string, size: number): readonly [number, number] | 'unsatisfiable' | undefined {
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) {
    return undefined
  }

  const [, first, last] = match

  // A suffix: the last bytes of the body, all of it when it asks for more than there is.
  if (first === '') {
    if (last === '') {
      return undefined
    }

    const length = Number(last)
    return length === 0 ? 'unsatisfiable' : [Math.max(size - length, 0), size - 1]
  }

  if (last !== '' && decimalLess(last, first)) {
    return undefined
  }

  const start = Number(first)

  if (start >= size) {
    return 'unsatisfiable'
  }

  return [start, last === '' ? size - 1 : Math.min(Number(last), size - 1)]
}

// Whether one string of digits names a smaller number than another, compared exactly: past 2 ** 53, two different
// numbers can convert to the same one.
function decimalLess(a: string, b: string): boolean {
  const x = a.replace(/^0+/, '')
  const y = b.replace(/^0+/, '')

  return x.length === y.length ? x < y : x.length < y.length
}
