import type { FetchyResponse } from '../response.js'

// Frees what a response thrown away still holds: cancels its body, read or not, unless a reader holds it, whose holder
// has to finish it. A cancel that fails is left alone: it has nothing left to free.
export async function discard(response: FetchyResponse): Promise<void> {
  const body = response.body

  if (body !== null && !body.locked) {
    await body.cancel().catch(() => undefined)
  }
}
