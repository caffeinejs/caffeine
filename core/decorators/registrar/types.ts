export type TypeID = Function | object

export type MemberKind = 'method' | 'field' | 'accessor' | 'getter' | 'setter'

export function idfy(id: TypeID | DecoratorContext): TypeID {
  if (typeof id === 'function') {
    return id as Function
  }

  if ('metadata' in id) {
    return id.metadata
  }

  if (Object.hasOwn(id, 'constructor') && id.constructor instanceof Function) {
    return id.constructor
  }

  return id as TypeID
}
