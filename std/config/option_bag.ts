/** A third-party option bag, split into the half a configuration tree can carry and the half it cannot. */
export interface SplitOptionBag {
  /** Everything that is not a function: what goes into the slice. */
  data: Record<string, unknown>
  /** The functions, held aside and merged back once the slice publishes. */
  callbacks: Record<string, unknown>
}

/**
 * Splits an option bag a feature forwards to a third-party library.
 *
 * A function cannot travel through a configuration tree — the validator cannot clone one, and it would be
 * stripped or rejected — so a feature whose options may carry callbacks writes {@link SplitOptionBag.data}
 * into its slice, keeps {@link SplitOptionBag.callbacks} on the builder, and merges the two back when it
 * constructs whatever consumes them.
 *
 * A configuration source that replaces the bag replaces only the data half; the callbacks the builder set
 * survive, since nothing outside the code could have supplied them.
 */
export function splitOptionBag(options: object): SplitOptionBag {
  const data: Record<string, unknown> = {}
  const callbacks: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'function') {
      callbacks[key] = value
    } else {
      data[key] = value
    }
  }

  return { data, callbacks }
}
