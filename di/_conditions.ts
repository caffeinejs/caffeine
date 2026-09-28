import { isConfigurationClass, type Binding } from './binding.js'
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
  // Registered with conditions a metadata reader gave it, rather than held: it answers to its keys until decided.
  readonly registered?: boolean
}

// A decorated configuration held for its conditions, or a conditional @Provides of one that is not: decided first.
function isHeldConfiguration(entry: Held): boolean {
  return (
    entry.byHand === undefined &&
    !entry.registered &&
    entry.providedByConfig === undefined &&
    entry.binding!.configuration === true
  )
}

// A decorated configuration class held for its conditions: its own @Provides go after it, and only once it passed.
export function isHeldClass(entry: Held): boolean {
  return isHeldConfiguration(entry) && isConfigurationClass(entry.binding!)
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

// The order conditions were always decided in: the conditional configuration classes, each followed by its own
// @Provides, and the conditional @Provides of unconditional classes, then every other held binding in the order it was
// held. A @Provides whose class is not held is left out.
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
    if (isHeldClass(entry)) {
      order.push(entry, ...(provided.get(entry.key) ?? []))
    } else if (isHeldConfiguration(entry)) {
      order.push(entry)
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

    if (isHeldClass(order[i])) {
      classAt.set(order[i].key, i)
    }
  }

  return order.map((entry, i) => {
    const own = entry.providedByConfig === undefined ? undefined : classAt.get(entry.providedByConfig)
    const isClass = isHeldClass(entry)
    const checked = keysChecked(entry.binding!)
      .flatMap(key => answering.get(key) ?? [])
      .filter(j => j !== i && !(isClass && order[j].providedByConfig === entry.key))
      .sort((a, b) => a - b)

    return [...new Set(own === undefined ? checked : [own, ...checked])]
  })
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

// The next binding to decide, as a position in the base order: the earliest undecided one whose waits are all decided,
// so without waits the order is the base order. When none is free, the one cycleStart picks, decided as if the
// bindings it still waits for were absent. Undefined once every binding is decided.
function next(waits: readonly number[][], done: readonly boolean[]): number | undefined {
  const first = done.indexOf(false)
  if (first === -1) {
    return undefined
  }

  for (let i = first; i < done.length; i++) {
    if (!done[i] && waits[i].every(j => done[j])) {
      return i
    }
  }

  return cycleStart(waits, done)
}

// Decides the held bindings one at a time, each after the held bindings it waits for, and after them the bindings
// `registered` returns, which a metadata reader gave conditions to. A condition may bind while it is decided: the queue
// is then a new array, or a longer one, and the order is worked out again with what it holds. Decided bindings stay in
// the order, done, so nothing decided is decided again and a decided class still leads to its @Provides.
export async function decideInOrder<E extends Held>(
  held: () => readonly E[],
  registered: () => readonly E[],
  decide: (entry: E) => Promise<void>,
): Promise<void> {
  const decided = new Set<E>()

  for (;;) {
    const queue = held()
    const size = queue.length
    const order = baseOrder([...queue, ...registered()])
    const waits = waitsOf(order)
    const done = order.map(entry => decided.has(entry))
    const unchanged = () => held() === queue && queue.length === size

    for (let i = next(waits, done); i !== undefined && unchanged(); i = next(waits, done)) {
      done[i] = true
      decided.add(order[i])
      await decide(order[i])
    }

    if (unchanged()) {
      return
    }
  }
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
