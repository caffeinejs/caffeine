import type { IncomingHttpHeaders } from 'node:http'

export function toUndiciHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}

  for (const [name, value] of headers) {
    record[name] = value
  }

  return record
}

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
