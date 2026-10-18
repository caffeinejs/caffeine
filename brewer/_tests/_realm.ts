// The object as another realm hands it over, an iframe's or a window's this one opened: the brand and the methods of
// its own classes, and none of this realm's, so `instanceof` fails it. Node has no other realm with `Blob`,
// `FormData` or web streams, so its prototypes are swapped for one copy of them.
export function fromAnotherRealm<T extends object>(value: T): T {
  const chain: object[] = []
  for (let proto = Object.getPrototypeOf(value); proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    chain.unshift(proto)
  }

  // Nearer prototypes last, so a File's brand wins over the Blob's it extends.
  const descriptors = Object.assign({}, ...chain.map(proto => Object.getOwnPropertyDescriptors(proto)))

  return Object.setPrototypeOf(value, Object.create(Object.prototype, descriptors)) as T
}
