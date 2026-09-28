import type { Binding } from './binding.js'
import type { Identifier, InjectionToken } from './key.js'
import { Keys } from './symbols.js'

// What the order reads of a binding held for its conditions.
export interface Held {
  readonly key: InjectionToken
  readonly binding?: Binding
  readonly providedByConfig?: InjectionToken
  readonly byHand?: 'bind' | 'restore'
  readonly profileRejected?: boolean
}

// A decorated configuration held for its conditions, or a conditional @Provides of one that is not: decided first.
function isHeldConfiguration(entry: Held): boolean {
  return entry.byHand === undefined && entry.providedByConfig === undefined && entry.binding!.configuration === true
}

// The keys a binding answers to once registered: its own, its names, and its base, which a configuration never maps.
function answersTo(entry: Held): Array<InjectionToken | Identifier> {
  const binding = entry.binding!
  const keys: Array<InjectionToken | Identifier> = [entry.key, ...binding.names]

  if (binding.extend !== undefined && !binding.configuration) {
    keys.push(binding.extend)
  }

  return keys
}

// The keys a binding's conditions read in the registry. A config condition reads the values provider.
function keysChecked(binding: Binding): InjectionToken[] {
  const keys: InjectionToken[] = []

  for (const condition of binding.conditionals) {
    if (condition.kind === 'present' || condition.kind === 'missing') {
      keys.push(condition.key)
    } else if (condition.kind === 'config') {
      keys.push(Keys.kValuesProvider)
    }
  }

  return keys
}

// The order conditions were always decided in: each conditional configuration class followed by its own @Provides,
// then every other held binding in the order it was held. A @Provides whose class is not held is left out.
function baseOrder<E extends Held>(pending: readonly E[]): E[] {
  const held = pending.filter(e => !e.profileRejected && e.binding !== undefined)
  const provided = new Map<InjectionToken, E[]>()

  for (const entry of held) {
    if (entry.providedByConfig !== undefined) {
      const list = provided.get(entry.providedByConfig)
      if (list === undefined) {
        provided.set(entry.providedByConfig, [entry])
      } else {
        list.push(entry)
      }
    }
  }

  const order: E[] = []

  for (const entry of held) {
    if (isHeldConfiguration(entry)) {
      order.push(entry, ...(provided.get(entry.key) ?? []))
    }
  }

  for (const entry of held) {
    if (entry.providedByConfig === undefined && !isHeldConfiguration(entry)) {
      order.push(entry)
    }
  }

  return order
}

// A min-heap of positions in the base order: the earliest binding free to be decided comes out first.
class Ready {
  readonly #heap: number[] = []

  get size(): number {
    return this.#heap.length
  }

  push(i: number): void {
    const heap = this.#heap
    heap.push(i)

    for (let c = heap.length - 1; c > 0;) {
      const p = (c - 1) >> 1
      if (heap[p] <= heap[c]) {
        break
      }

      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }

  pop(): number {
    const heap = this.#heap
    const top = heap[0]
    const last = heap.pop()!

    if (heap.length > 0) {
      heap[0] = last

      for (let p = 0; ;) {
        const l = 2 * p + 1
        const r = l + 1
        let m = p

        if (l < heap.length && heap[l] < heap[m]) {
          m = l
        }

        if (r < heap.length && heap[r] < heap[m]) {
          m = r
        }

        if (m === p) {
          break
        }

        ;[heap[p], heap[m]] = [heap[m], heap[p]]
        p = m
      }
    }

    return top
  }
}

// Walks from the earliest undecided binding through what it waits for, its class first, until a binding repeats, and
// returns the earliest binding on that cycle. A binding that only waits on a cycle is never the one forced.
function cycleStart(waits: number[][], classOf: Array<number | undefined>, decided: boolean[]): number {
  const seen = new Map<number, number>()
  const path: number[] = []
  let i = decided.indexOf(false)

  while (!seen.has(i)) {
    seen.set(i, path.length)
    path.push(i)

    const own = classOf[i]
    i = own !== undefined && !decided[own] ? own : waits[i].find(j => !decided[j])!
  }

  return Math.min(...path.slice(seen.get(i)))
}

// Orders the held bindings so each is decided after the held bindings it waits for. A @Provides waits for its class,
// and a binding whose present, missing or config condition checks a key waits for every other held binding answering
// to that key, never for itself, and a class never for its own @Provides. Among the bindings free to go, the earliest in
// the base order goes first, so without such conditions the order is the base order. When none is free, the cycle is
// broken at its earliest binding, decided as if the bindings it still waits for were absent; no decision is revisited.
export function decisionOrder<E extends Held>(pending: readonly E[]): E[] {
  const order = baseOrder(pending)
  const n = order.length
  const answering = new Map<InjectionToken | Identifier, number[]>()
  const classAt = new Map<InjectionToken, number>()

  for (let i = 0; i < n; i++) {
    for (const key of answersTo(order[i])) {
      const list = answering.get(key)
      if (list === undefined) {
        answering.set(key, [i])
      } else {
        list.push(i)
      }
    }

    if (isHeldConfiguration(order[i])) {
      classAt.set(order[i].key, i)
    }
  }

  const classOf: Array<number | undefined> = []
  const waits: number[][] = []
  const remaining: number[] = []
  const dependents: number[][] = order.map((): number[] => [])

  for (let i = 0; i < n; i++) {
    const entry = order[i]
    const own = entry.providedByConfig === undefined ? undefined : classAt.get(entry.providedByConfig)
    const waitsFor = new Set<number>(own === undefined ? [] : [own])

    for (const key of keysChecked(entry.binding!)) {
      for (const j of answering.get(key) ?? []) {
        if (j !== i && order[j].providedByConfig !== entry.key) {
          waitsFor.add(j)
        }
      }
    }

    classOf.push(own)
    waits.push([...waitsFor].sort((a, b) => a - b))
    remaining.push(waitsFor.size)

    for (const j of waitsFor) {
      dependents[j].push(i)
    }
  }

  const decided = new Array<boolean>(n).fill(false)
  const ready = new Ready()

  for (let i = 0; i < n; i++) {
    if (remaining[i] === 0) {
      ready.push(i)
    }
  }

  const result: E[] = []

  while (result.length < n) {
    const next = ready.size > 0 ? ready.pop() : cycleStart(waits, classOf, decided)
    if (decided[next]) {
      continue
    }

    decided[next] = true
    result.push(order[next])

    for (const d of dependents[next]) {
      remaining[d]--
      if (remaining[d] === 0 && !decided[d]) {
        ready.push(d)
      }
    }
  }

  return result
}
