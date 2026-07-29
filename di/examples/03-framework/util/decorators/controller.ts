import { Injection, composeDecorators, Injectable, Label, Tag } from '@caffeinejs/di'

export function Controller(path: string, dependencies?: Injection[]) {
  return composeDecorators(
    Injectable(dependencies ?? []),
    Label(Symbol.for('controller')),
    Tag(Symbol.for('controller:base'), path),
  )
}
