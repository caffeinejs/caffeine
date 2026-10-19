// The one byte range a `Range` header asks of a body of `size` bytes, as RFC 9110 §14 reads it: `[first, last]`, both
// inside the body, or `'unsatisfiable'` for a range that starts past its end. `undefined` when the body is to be sent
// whole: another unit, a malformed or reversed range, more than one range, or an empty body.
export function byteRange(
  header: string | undefined,
  size: number,
): readonly [number, number] | 'unsatisfiable' | undefined {
  if (header === undefined || size === 0) {
    return undefined
  }

  // The unit is compared without regard to case.
  const equals = header.indexOf('=')
  if (equals === -1 || header.slice(0, equals).toLowerCase() !== 'bytes') {
    return undefined
  }

  // Empty list elements are skipped, as a list's recipient must.
  let spec: string | undefined
  for (const element of header.slice(equals + 1).split(',')) {
    const trimmed = element.trim()
    if (trimmed === '') {
      continue
    }

    if (spec !== undefined) {
      return undefined
    }

    spec = trimmed
  }

  const match = spec === undefined ? null : /^(\d*)-(\d*)$/.exec(spec)
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

  const start = Number(first)

  if (last !== '' && Number(last) < start) {
    return undefined
  }

  if (start >= size) {
    return 'unsatisfiable'
  }

  return [start, last === '' ? size - 1 : Math.min(Number(last), size - 1)]
}
