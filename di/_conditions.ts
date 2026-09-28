import type { Binding } from './binding.js'
import type { Condition } from './conditional.js'
import type { ContainerOps } from './container_interface.js'
import { ErrInvalidBinding, ErrNoValuesProvider } from './errors.js'
import { solutions } from './internal/util/errutil/index.js'
import { selector } from './internal/util/objects/index.js'
import { keyStr, type Identifier, type InjectionToken } from './key.js'
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

// Adds `value` to the list `map` holds under `key`.
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) {
    map.set(key, [value])
  } else {
    list.push(value)
  }
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
      append(provided, entry.providedByConfig, entry)
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

// What each held binding waits for, as positions in the base order. A @Provides waits for its class, listed first, and
// a binding whose present, missing or config condition checks a key waits for every other held binding answering to
// that key, listed in ascending order, never for itself, and a class never for its own @Provides.
function waitsOf(order: readonly Held[]): number[][] {
  const answering = new Map<InjectionToken | Identifier, number[]>()
  const classAt = new Map<InjectionToken, number>()

  for (let i = 0; i < order.length; i++) {
    for (const key of answersTo(order[i])) {
      append(answering, key, i)
    }

    if (isHeldConfiguration(order[i])) {
      classAt.set(order[i].key, i)
    }
  }

  return order.map((entry, i) => {
    const own = entry.providedByConfig === undefined ? undefined : classAt.get(entry.providedByConfig)
    const checked = keysChecked(entry.binding!)
      .flatMap(key => answering.get(key) ?? [])
      .filter(j => j !== i && order[j].providedByConfig !== entry.key)
      .sort((a, b) => a - b)

    return [...new Set(own === undefined ? checked : [own, ...checked])]
  })
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

// Walks from the earliest undecided binding to the first binding it still waits for, and on, until a binding repeats,
// and returns the earliest binding on that cycle. A binding that only waits on a cycle is never the one forced. A
// @Provides leads to its class while the class is undecided, so the walk follows what gates it before anything else.
function cycleStart(waits: readonly number[][], decided: readonly boolean[]): number {
  const seen = new Map<number, number>()
  const path: number[] = []
  let i = decided.indexOf(false)

  while (!seen.has(i)) {
    seen.set(i, path.length)
    path.push(i)
    i = waits[i].find(j => !decided[j])!
  }

  return Math.min(...path.slice(seen.get(i)))
}

// The positions in the order they are decided. Among the bindings free to go, the earliest in the base order goes
// first, so without waits the order is the base order. When none is free, the binding cycleStart picks is decided as
// if the bindings it still waits for were absent, and no decision is revisited.
function schedule(waits: readonly number[][]): number[] {
  const remaining = waits.map(w => w.length)
  const dependents = waits.map((): number[] => [])
  const decided = waits.map(() => false)
  const ready = new Ready()

  for (let i = 0; i < waits.length; i++) {
    for (const j of waits[i]) {
      dependents[j].push(i)
    }

    if (remaining[i] === 0) {
      ready.push(i)
    }
  }

  const order: number[] = []

  while (order.length < waits.length) {
    const next = ready.size > 0 ? ready.pop() : cycleStart(waits, decided)

    decided[next] = true
    order.push(next)

    for (const d of dependents[next]) {
      remaining[d]--
      if (remaining[d] === 0 && !decided[d]) {
        ready.push(d)
      }
    }
  }

  return order
}

// Orders the held bindings so each is decided after the held bindings it waits for, a cycle broken at its earliest
// binding.
export function decisionOrder<E extends Held>(pending: readonly E[]): E[] {
  const order = baseOrder(pending)

  return schedule(waitsOf(order)).map(i => order[i])
}

// Read through globalThis, so di carries no host binding: where the runtime has no process.env, every variable is unset.
function hostEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
}

// Whether a binding other than the one being decided answers to the key, so a condition never sees its own binding.
function answered(container: ContainerOps, key: InjectionToken, self: Binding): boolean {
  return container.getBindings(key).some(b => b.id !== self.id)
}

// A config condition reads the values provider before the container has compiled, so only through a factory that
// needs nothing compile() builds.
function readValuesProvider(container: ContainerOps, key: InjectionToken): unknown {
  const provider = container.getBinding(Keys.kValuesProvider)
  if (provider === undefined) {
    throw new ErrNoValuesProvider(`Read by the config condition of "${keyStr(key)}"`)
  }

  if (
    typeof provider.factory !== 'function' ||
    provider.type !== undefined ||
    provider.factoryCreator !== undefined ||
    provider.async === true ||
    provider.injections.length > 0
  ) {
    throw new ErrInvalidBinding(
      `Cannot decide the config condition of "${keyStr(key)}": the values provider cannot be read before init()` +
        solutions(`Bind the values provider with toValue(), or with toFactory() and no injections`),
    )
  }

  return provider.factory({ container, key: Keys.kValuesProvider, binding: provider })
}

async function decide(
  container: ContainerOps,
  key: InjectionToken,
  binding: Binding,
  condition: Condition,
): Promise<boolean> {
  switch (condition.kind) {
    case 'present':
      return answered(container, condition.key, binding)
    case 'missing':
      return !answered(container, condition.key, binding)
    case 'config':
      return selector(condition.access)(readValuesProvider(container, key)) === condition.expected
    case 'env': {
      const value = hostEnv()?.[condition.name]

      return condition.expected === undefined ? value !== undefined && value !== '' : value === condition.expected
    }
    case 'when':
      return Boolean(await condition.test())
    default:
      throw new ErrInvalidBinding(
        `Cannot decide the conditions of "${keyStr(key)}": one of them is not a condition` +
          solutions(`Build conditions with $cond, e.g. $cond.when(() => ...)`),
      )
  }
}

// Decides the conditions of a binding in order, stopping at the first that fails.
export async function passes(container: ContainerOps, key: InjectionToken, binding: Binding): Promise<boolean> {
  for (const condition of binding.conditionals) {
    if (!(await decide(container, key, binding, condition))) {
      return false
    }
  }

  return true
}
