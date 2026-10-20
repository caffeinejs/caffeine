/** One downstream call. `join` and every combinator pass the signal the call must honour. */
export type Call<T> = (signal: AbortSignal) => Promise<T>
