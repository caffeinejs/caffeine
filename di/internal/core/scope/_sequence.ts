// One counter for every durable scope in the process. Singleton and refresh keep separate caches, so a
// per-scope counter would lose their relative order — which is exactly what disposal needs.

let sequence = 0

export function nextSequence(): number {
  return sequence++
}
