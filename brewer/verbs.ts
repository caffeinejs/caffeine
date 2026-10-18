/**
 * The methods the proxy exposes as a call.
 *
 * One list, read by both the runtime and the types, so a segment the types hide is exactly a segment the runtime
 * cannot reach, and a method the types offer is one the runtime sends. A method outside it is sent with `$request`.
 */
export const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'query'] as const

export type Verb = (typeof VERBS)[number]

const lookup: ReadonlySet<string> = new Set(VERBS)

export function isVerb(name: string): name is Verb {
  return lookup.has(name)
}
