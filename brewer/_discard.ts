/** A request or a response: whatever carries a body. */
interface Carrier {
  readonly body: ReadableStream | null
}

// Cancels what is left of each body, read in part or not at all, since a body left unread holds its connection. One
// still locked to a reader cannot be cancelled, and one that fails to cancel has nothing left to free. All at once: a
// body and its `clone()` share a tee, which settles a cancel only once both are cancelled.
export async function discard(...carriers: ReadonlyArray<Carrier | null | undefined>): Promise<void> {
  await Promise.all(
    carriers.map(async carrier => {
      const body = carrier?.body
      if (body !== null && body !== undefined && !body.locked) {
        await body.cancel().catch(() => undefined)
      }
    }),
  )
}
