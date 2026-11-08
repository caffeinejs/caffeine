// Read before a test fakes the timers: the turns below must be real ones.
const nextTurn = globalThis.setImmediate

/**
 * Runs `scenario`, whose own promises it must handle, then lets the event loop turn on real timers, and returns
 * every rejection that nothing handled meanwhile: one a policy left behind on a path the caller never sees.
 */
export async function unhandledRejections(scenario: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = []
  const record = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', record)
  try {
    await scenario()
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => nextTurn(resolve))
    }
  } finally {
    process.off('unhandledRejection', record)
  }
  return seen
}
