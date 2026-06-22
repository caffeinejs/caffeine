export function trackForCollection(target: object): () => boolean {
  const ref = new WeakRef(target)
  return () => ref.deref() === undefined
}
