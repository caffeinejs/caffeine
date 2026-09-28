import type { IncomingHttpHeaders } from 'node:http'

export function fromUndiciHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(name, entry)
      }
    } else {
      result.append(name, value)
    }
  }

  return result
}
